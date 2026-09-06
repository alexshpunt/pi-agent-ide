import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
  type ReadPluginApi,
} from "#src/api/plugin-protocol.js";
import {
  isFragmentResolverRegistration,
  isReadHandlerRegistration,
  isReadViewRegistration,
  isResourceResolverRegistration,
  isTextTargetResolverRegistration,
  type FragmentResolverRegistration,
  type PromptDescriptionSource,
  type ReadHandlerRegistration,
  type ReadViewRegistration,
  type ResourceResolverRegistration,
  type TextTargetResolverRegistration,
} from "#src/api/tools/read.js";
import { createReadTool, type ReadTool } from "#src/core/tools/tool-read.js";

type PluginStatus = "active" | "pending";

interface PluginLifecycle {
  status: PluginStatus;
}

interface RegisteredPlugin {
  readonly lifecycle: PluginLifecycle;
  readonly plugin: ReadPlugin;
  readonly promptContributions: PromptDescriptionSource[];

  readonly promptGuidelines: PromptDescriptionSource[];
  readonly ready: Promise<void>;
}

interface PluginContributionController {
  readonly api: ReadPluginApi;
  close(): void;
  commit(): void;
}

export interface ReadCore {
  readonly read: ReadTool;
  registerPlugin(plugin: ReadPlugin): Promise<void>;
  waitForPendingPlugins(): Promise<void>;
  renderPluginPromptGuideline(): string | undefined;
}

export function createReadCore(): ReadCore {
  const pendingPlugins = new Set<Promise<void>>();
  const plugins = new Map<string, RegisteredPlugin>();
  const read = createReadTool(() => renderPromptGuidelines(plugins));
  let registrationQueue = Promise.resolve();

  return {
    read,
    registerPlugin(plugin): Promise<void> {
      const validationError = getPluginValidationError(plugin);

      if (validationError !== undefined) {
        return Promise.reject(validationError);
      }

      const existing = plugins.get(plugin.id);

      if (existing?.plugin === plugin) {
        return existing.ready;
      }

      if (existing !== undefined) {
        return Promise.reject(new Error(`Plugin ${plugin.id} is already registered`));
      }

      const lifecycle: PluginLifecycle = { status: "pending" };
      const promptContributions: PromptDescriptionSource[] = [];

      const promptGuidelines: PromptDescriptionSource[] = [];
      const contributions = createPluginContributionController(
        plugin.id,
        read,
        promptGuidelines,
        promptContributions,
      );
      const ready = registrationQueue.then(async () => {
        try {
          await plugin.setup(contributions.api);
          contributions.commit();
          lifecycle.status = "active";
          return;
        } catch (error) {
          contributions.close();
          throw error;
        }
      });
      const registeredPlugin: RegisteredPlugin = {
        lifecycle,
        plugin,
        promptGuidelines,
        promptContributions,
        ready,
      };

      plugins.set(plugin.id, registeredPlugin);
      pendingPlugins.add(ready);
      registrationQueue = ready.catch(() => {});
      void ready.then(
        () => {
          pendingPlugins.delete(ready);
          return;
        },
        () => {
          pendingPlugins.delete(ready);

          if (plugins.get(plugin.id) === registeredPlugin) {
            plugins.delete(plugin.id);
          }

          return;
        },
      );

      return ready;
    },
    renderPluginPromptGuideline: () => renderPluginPromptGuideline(plugins),
    async waitForPendingPlugins(): Promise<void> {
      await Promise.all(pendingPlugins);
    },
  };
}

function getPluginValidationError(plugin: {
  readonly apiVersion: number;
  readonly id: string;
  readonly protocol: string;
}): Error | undefined {
  if (plugin.protocol !== READ_PROTOCOL) {
    return new Error(`Plugin ${plugin.id} uses an unsupported protocol`);
  }

  if (plugin.apiVersion !== READ_API_VERSION) {
    return new Error(`Plugin ${plugin.id} uses an unsupported API version`);
  }

  if (plugin.id.trim().length === 0) {
    return new Error("Plugin ID must not be empty");
  }

  return undefined;
}

function createPluginContributionController(
  pluginId: string,
  read: ReadTool,
  promptGuidelines: PromptDescriptionSource[],
  promptContributions: PromptDescriptionSource[],
): PluginContributionController {
  const setupPromptContributions: PromptDescriptionSource[] = [];

  const setupPromptGuidelines: PromptDescriptionSource[] = [];
  const setupResolvers: ResourceResolverRegistration[] = [];
  const setupTargetResolvers: TextTargetResolverRegistration[] = [];
  const setupReadHandlers: ReadHandlerRegistration[] = [];
  const setupViews: ReadViewRegistration[] = [];
  const setupFragmentResolvers: FragmentResolverRegistration[] = [];
  let state: "active" | "closed" | "setup" = "setup";
  const assertAvailable = (): void => {
    if (state === "closed") {
      throw new Error(`Plugin ${pluginId} API is closed`);
    }
  };
  const api: ReadPluginApi = {
    read(request, context) {
      assertAvailable();
      return read.execute(request, context);
    },
    addResolver(registration): void {
      assertAvailable();
      if (!isResourceResolverRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid resource resolver`);
      }
      if (state === "setup") {
        setupResolvers.push(registration);
        return;
      }
      read.registerContributions(pluginId, { resolvers: [registration] });
    },
    addTargetResolver(registration): void {
      assertAvailable();
      if (!isTextTargetResolverRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid text target resolver`);
      }
      if (state === "setup") {
        setupTargetResolvers.push(registration);
        return;
      }
      read.registerContributions(pluginId, { targetResolvers: [registration] });
    },
    addHandler(registration): void {
      assertAvailable();

      if (!isReadHandlerRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid read handler`);
      }

      if (state === "setup") {
        setupReadHandlers.push(registration);
        return;
      }

      read.registerContributions(pluginId, { handlers: [registration] });
    },
    addView(registration): void {
      assertAvailable();

      if (!isReadViewRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid view registration`);
      }

      if (state === "setup") {
        setupViews.push(registration);
        return;
      }

      read.registerContributions(pluginId, { views: [registration] });
    },
    addFragmentResolver(registration): void {
      assertAvailable();

      if (!isFragmentResolverRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid fragment resolver`);
      }

      if (state === "setup") {
        setupFragmentResolvers.push(registration);
        return;
      }

      read.registerContributions(pluginId, { fragments: [registration] });
    },
    describe(description): void {
      assertAvailable();

      if (setupPromptContributions.length > 0 || promptContributions.length > 0) {
        throw new Error(`Plugin ${pluginId} provides more than one description`);
      }

      const normalized = normalizeDescriptionSource(description);

      if (state === "setup") {
        setupPromptContributions.push(normalized);
        return;
      }

      promptContributions.push(normalized);
    },

    addPromptGuideline(guideline): void {
      assertAvailable();
      const normalized = normalizeDescriptionSource(guideline);

      if (state === "setup") {
        setupPromptGuidelines.push(normalized);
        return;
      }

      promptGuidelines.push(normalized);
    },
  };

  return {
    api,
    close(): void {
      state = "closed";
    },
    commit(): void {
      if (state !== "setup") {
        throw new Error(`Plugin ${pluginId} setup contributions cannot be committed`);
      }

      read.registerContributions(pluginId, {
        resolvers: setupResolvers,
        targetResolvers: setupTargetResolvers,
        handlers: setupReadHandlers,
        views: setupViews,
        fragments: setupFragmentResolvers,
      });
      promptContributions.push(...setupPromptContributions);

      promptGuidelines.push(...setupPromptGuidelines);
      state = "active";
    },
  };
}

function renderPromptGuidelines(plugins: ReadonlyMap<string, RegisteredPlugin>): readonly string[] {
  const guidelines: string[] = [];

  for (const registeredPlugin of plugins.values()) {
    if (registeredPlugin.lifecycle.status !== "active") {
      continue;
    }

    for (const source of registeredPlugin.promptGuidelines) {
      const guideline = renderDescriptionSource(source);
      if (guideline !== undefined) {
        guidelines.push(guideline);
      }
    }
  }

  return guidelines;
}

function renderPluginPromptGuideline(
  plugins: ReadonlyMap<string, RegisteredPlugin>,
): string | undefined {
  const entries: string[] = [];

  for (const registeredPlugin of plugins.values()) {
    if (registeredPlugin.lifecycle.status !== "active") {
      continue;
    }

    const source = registeredPlugin.promptContributions[0];

    if (source === undefined) {
      continue;
    }

    const description = renderDescriptionSource(source);

    if (description !== undefined) {
      entries.push(renderPromptEntry(registeredPlugin.plugin.id, description));
    }
  }

  return entries.length === 0
    ? undefined
    : indentGuidelineContinuation(
        ["Read supports these installed protocols:", ...entries].join("\n"),
      );
}

function normalizeDescriptionSource(value: unknown): PromptDescriptionSource {
  if (typeof value === "string") {
    return normalizeDescription(value);
  }

  if (typeof value === "function") {
    return value as () => string | undefined;
  }

  throw new TypeError("Read plugin prompt description must be a string or callback");
}

function renderDescriptionSource(source: PromptDescriptionSource): string | undefined {
  if (typeof source === "string") {
    return source;
  }

  const value: unknown = source();
  return value === undefined ? undefined : normalizeDescription(value);
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Read plugin prompt description must be a string");
  }

  const lines = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  while (lines[0]?.trim().length === 0) {
    lines.shift();
  }

  while (lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }

  const description = lines.join("\n");

  if (description.trim().length === 0) {
    throw new Error("Read plugin prompt description is empty");
  }

  return description;
}

function renderPromptEntry(pluginId: string, description: string): string {
  const [firstLine, ...continuationLines] = description.split("\n");

  return [
    `- \`${escapeInlineCode(pluginId)}\` — ${firstLine ?? ""}`,
    ...continuationLines.map((line) => `  ${line}`),
  ].join("\n");
}

function indentGuidelineContinuation(guideline: string): string {
  const [firstLine, ...continuationLines] = guideline.split("\n");
  return [
    firstLine ?? "",
    ...continuationLines.map((line) => (line.length === 0 ? line : `  ${line}`)),
  ].join("\n");
}

function escapeInlineCode(value: string): string {
  return value.replaceAll("`", "\\`");
}
