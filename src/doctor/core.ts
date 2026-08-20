import type {
  DoctorCheck,
  DoctorContext,
  DoctorFinding,
  DoctorPlugin,
  DoctorPluginApi,
} from "#src/api/doctor.js";
import type { LanguageDefinition, ToolRecipe } from "#src/api/tool-catalog.js";

export interface OwnedContribution<T> {
  readonly pluginId: string;
  readonly value: T;
}

export interface DoctorSnapshot {
  readonly languages: readonly OwnedContribution<LanguageDefinition>[];
  readonly recipes: readonly OwnedContribution<ToolRecipe>[];
  readonly checks: readonly OwnedContribution<DoctorCheck>[];
}

/**
Aggregates independent doctor contributions without importing their owners.
*/
export class DoctorCore {
  private readonly plugins = new Map<string, Promise<void>>();
  private readonly languages: OwnedContribution<LanguageDefinition>[] = [];
  private readonly recipes: OwnedContribution<ToolRecipe>[] = [];
  private readonly checks: OwnedContribution<DoctorCheck>[] = [];
  private queue = Promise.resolve();

  /**
    Registers one independent plugin exactly once.
    */
  public registerPlugin(plugin: DoctorPlugin): Promise<void> {
    const existing = this.plugins.get(plugin.id);

    if (existing !== undefined) {
      return existing;
    }

    const ready = this.queue.then(async () => {
      let isOpen = true;
      const ownLanguages: OwnedContribution<LanguageDefinition>[] = [];
      const ownRecipes: OwnedContribution<ToolRecipe>[] = [];
      const ownChecks: OwnedContribution<DoctorCheck>[] = [];
      const api: DoctorPluginApi = {
        addLanguage: (value) => {
          add(value, ownLanguages, plugin.id, "language", () => isOpen);
        },
        addToolRecipe: (value) => {
          add(value, ownRecipes, plugin.id, "tool recipe", () => isOpen);
        },
        addCheck: (value) => {
          add(value, ownChecks, plugin.id, "check", () => isOpen);
        },
      };

      try {
        await plugin.setup(api);
      } finally {
        isOpen = false;
      }

      assertAvailable(this.languages, ownLanguages, "language");
      assertAvailable(this.recipes, ownRecipes, "tool recipe");
      this.languages.push(...ownLanguages);
      this.recipes.push(...ownRecipes);
      this.checks.push(...ownChecks);
      return undefined;
    });
    this.plugins.set(plugin.id, ready);
    this.queue = ready.catch(() => undefined);
    void ready.catch(() => {
      this.plugins.delete(plugin.id);
      return undefined;
    });
    return ready;
  }

  /**
    Waits for every contribution accepted in this load cycle.
    */
  public async waitForPlugins(): Promise<void> {
    await Promise.all(this.plugins.values());
  }

  /**
    Returns an immutable view used by one doctor run.
    */
  public snapshot(): DoctorSnapshot {
    return {
      languages: [...this.languages],
      recipes: [...this.recipes],
      checks: [...this.checks],
    };
  }
}

/**
Executes checks independently so one broken plugin cannot hide the rest.
*/
export async function runContributedChecks(
  snapshot: DoctorSnapshot,
  context: DoctorContext,
): Promise<
  readonly {
    readonly pluginId: string;
    readonly title: string;
    readonly findings: readonly DoctorFinding[];
  }[]
> {
  const results = [];

  for (const contribution of snapshot.checks) {
    try {
      results.push({
        pluginId: contribution.pluginId,
        title: contribution.value.title,
        findings: await contribution.value.run(context),
      });
    } catch (error) {
      results.push({
        pluginId: contribution.pluginId,
        title: contribution.value.title,
        findings: [
          {
            status: "fail" as const,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  return results;
}

function assertAvailable<T extends { readonly id: string }>(
  existing: readonly OwnedContribution<T>[],
  incoming: readonly OwnedContribution<T>[],
  kind: string,
): void {
  for (const contribution of incoming) {
    const owner = existing.find((entry) => entry.value.id === contribution.value.id)?.pluginId;

    if (owner !== undefined) {
      throw new Error(
        `${kind} ${contribution.value.id} is already owned by doctor plugin ${owner}`,
      );
    }
  }
}

function add<T extends { readonly id: string }>(
  value: T,
  target: OwnedContribution<T>[],
  pluginId: string,
  kind: string,
  isOpen: () => boolean,
): void {
  if (!isOpen()) {
    throw new Error(`Doctor plugin ${pluginId} setup is complete`);
  }

  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(value.id)) {
    throw new Error(`Invalid ${kind} ID: ${value.id}`);
  }

  if (target.some((entry) => entry.value.id === value.id)) {
    throw new Error(`Doctor plugin ${pluginId} registered ${kind} ${value.id} twice`);
  }

  target.push({ pluginId, value });
}
