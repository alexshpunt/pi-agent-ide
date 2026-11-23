import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Problem } from "pi-problem-report";
import type { GuardOwner } from "./problem-reports.ts";
import type { BuiltinExtension, BuiltinExtensionContext } from "./selection.ts";

/**
 * Register built-ins in order. A module that throws is reported and switched off: its hooks stop
 * running and its tools refuse to run. Modules that depend on it are skipped; the others load.
 * Returns the IDs of modules that did not load.
 */
export async function registerBuiltinModules<TApi extends ExtensionAPI>(
  modules: readonly BuiltinExtension[],
  api: TApi,
  context: BuiltinExtensionContext,
  problems: {
    guard(api: TApi, owner: GuardOwner): TApi;
    report(problem: Problem): void;
  },
): Promise<ReadonlySet<string>> {
  const failed = new Set<string>();
  for (const module of modules) {
    if (module.dependencies.some((dependency) => failed.has(dependency))) {
      failed.add(module.id);
      continue;
    }
    let disabled = false;
    try {
      await module.register(
        problems.guard(api, { id: module.id, disabled: () => disabled }),
        context,
      );
    } catch (error) {
      disabled = true;
      failed.add(module.id);
      const dependents = dependentsOf(modules, module.id).map((item) => item.name ?? item.id);
      problems.report({
        summary: `${module.name ?? module.id} module failed to load`,
        error,
        context: [`Module: ${module.id}`],
        consequence: `The other Pi Agent IDE modules keep working${
          dependents.length > 0 ? `, except ${dependents.join(", ")}, which need it` : ""
        }. Please report this so it can be fixed:`,
      });
    }
  }
  return failed;
}

/** Modules that need `id`, directly or through another module. */
function dependentsOf(modules: readonly BuiltinExtension[], id: string): BuiltinExtension[] {
  const needed = new Set([id]);
  const dependents: BuiltinExtension[] = [];
  for (const module of modules) {
    if (
      !needed.has(module.id) &&
      module.dependencies.some((dependency) => needed.has(dependency))
    ) {
      needed.add(module.id);
      dependents.push(module);
    }
  }
  return dependents;
}
