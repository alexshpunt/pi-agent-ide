import { registerTools } from "#src/toolchain/registry.js";

import { DiagnosticStore } from "#src/core/diagnostic-store.js";

import type { IdeDiagnosticSource, IdePlugin, IdePluginApi } from "#src/api/plugin-protocol.js";
import type { IdeTool } from "#src/toolchain/types.js";

export interface IdeCore {
  readonly diagnostics: DiagnosticStore;
  registerPlugin(plugin: IdePlugin): Promise<void>;
  waitForPendingPlugins(): Promise<void>;
}

export function createIdeCore(): IdeCore {
  const plugins = new Map<string, Promise<void>>();
  const diagnosticSources: IdeDiagnosticSource[] = [];

  const diagnostics = new DiagnosticStore(diagnosticSources);
  let queue = Promise.resolve();

  return {
    diagnostics,
    registerPlugin(plugin): Promise<void> {
      if (plugin.id.trim().length === 0) {
        return Promise.reject(new Error("Plugin ID must not be empty"));
      }

      const existing = plugins.get(plugin.id);

      if (existing !== undefined) {
        return existing;
      }

      const ready = queue.then(async () => {
        const tools: IdeTool[] = [];
        const incomingDiagnosticSources: IdeDiagnosticSource[] = [];
        let isOpen = true;
        const api: IdePluginApi = {
          addTool(tool): void {
            if (!isOpen) {
              throw new Error(`Plugin ${plugin.id} setup is already complete`);
            }

            assertIdeTool(tool);
            tools.push(tool);
          },
          addDiagnosticSource(source): void {
            if (!isOpen) {
              throw new Error(`Plugin ${plugin.id} setup is already complete`);
            }

            assertDiagnosticSource(source);
            incomingDiagnosticSources.push(source);
          },
          readDiagnostics(filePath, context) {
            return diagnostics.read(filePath, context);
          },
        };

        try {
          await plugin.setup(api);
        } catch (error) {
          isOpen = false;
          throw error;
        }

        isOpen = false;
        assertUniqueDiagnosticSources(diagnosticSources, incomingDiagnosticSources);
        registerTools(tools);
        diagnosticSources.push(...incomingDiagnosticSources);
      });
      plugins.set(plugin.id, ready);
      queue = ready.catch(() => {});
      void ready.catch(() => {
        plugins.delete(plugin.id);
        return;
      });
      return ready;
    },
    async waitForPendingPlugins(): Promise<void> {
      await Promise.all(plugins.values());
    },
  };
}

function assertUniqueDiagnosticSources(
  registered: readonly IdeDiagnosticSource[],
  incoming: readonly IdeDiagnosticSource[],
): void {
  const ids = new Set(registered.map((source) => source.id));

  for (const source of incoming) {
    if (ids.has(source.id)) {
      throw new Error(`Diagnostic source ${source.id} is already registered`);
    }

    ids.add(source.id);
  }
}

function assertIdeTool(value: unknown): asserts value is IdeTool {
  if (!isRecord(value)) {
    throw new TypeError("IDE tool must be an object");
  }

  const kind = value.kind;
  const execute =
    kind === "compiler"
      ? value.compile
      : kind === "formatter"
        ? value.format
        : kind === "linter"
          ? value.lint
          : undefined;

  if (
    execute === undefined ||
    typeof execute !== "function" ||
    typeof value.detect !== "function" ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.priority !== "number" ||
    !Number.isFinite(value.priority) ||
    !Array.isArray(value.extensions) ||
    value.extensions.length === 0 ||
    value.extensions.some((extension) => typeof extension !== "string" || extension.length === 0)
  ) {
    throw new TypeError("Invalid pi-agent-ide tool contribution");
  }
}

function assertDiagnosticSource(value: unknown): asserts value is IdeDiagnosticSource {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.diagnose !== "function"
  ) {
    throw new TypeError("Invalid pi-agent-ide diagnostic source contribution");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
