import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { createSourceMappedTextReadHandler } from "pi-agent-ide/api/code-view";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { resolveExternalToolProjectRoot } from "pi-agent-ide/api/tool-config";
import path from "node:path";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";
import type { IdeTool } from "pi-agent-ide/api/toolchain";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

import { LSP_RECIPES } from "./src/catalog.js";
import { createLspGraphResolver, createLspSymbolResolver } from "./src/code-view-resolvers.js";
import { createLspDiagnosticSource } from "./src/diagnostic-source.js";
import { lspDoctorPlugin } from "./src/doctor-plugin.js";
import { createLspCompiler, LspManager, LspServerRegistry } from "./src/lsp/index.js";
import { createLspSearchResolver } from "./src/search-resolver.js";
import { createDeclarationTargets } from "./src/declaration-targets.js";
import { prepareSymbolRename } from "./src/rename-plan.js";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_PROTOCOL,
  TEXT_EDITOR_API_VERSION,
  TEXT_SEARCH_ANCHOR_KIND,
} from "pi-agent-text-editor/api/plugin-protocol";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Backend-neutral language server transport for root registration bridges. */
import type { LspWorkspaceOwner } from "./src/lsp/workspace-owner.js";
import { SharedStartup, waitWithSignal } from "./src/lsp/abort.js";
export type { LspWorkspaceOwner } from "./src/lsp/workspace-owner.js";
export type {
  LspFileWatcherSubscriptions,
  WatchPattern,
  WatchedFileChange,
} from "./src/lsp/file-watchers.js";
export type { LspOwnerTransport, LspOwnedProcess } from "./src/lsp/owner-transport.js";
export { LspServerRegistry } from "./src/lsp/registry.js";
export { LSP_RECIPES } from "./src/catalog.js";
const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "LSP" });

/** Resource-owner hooks for root registration without backend imports in the LSP package. */
export interface LspRegistrationOwner {
  loadRegistry(cwd: string, external: boolean, signal?: AbortSignal): Promise<LspServerRegistry>;
  workspace(cwd: string): LspWorkspaceOwner | undefined;
  resolveProject(
    filePath: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ cwd: string; external: boolean } | undefined>;
}

export default async function registerLsp(pi: ExtensionAPI): Promise<void> {
  await registerLspWithOwner(pi);
}

/** Register ordinary LSP tools, optionally using explicit workspace-owner hooks. */
export async function registerLspWithOwner(
  pi: ExtensionAPI,
  owner?: LspRegistrationOwner,
): Promise<void> {
  const managers = new Map<string, SharedStartup<LspManager>>();
  let disposed = false;
  const managerFor = async (
    cwd: string,
    external = false,
    signal?: AbortSignal,
  ): Promise<LspManager> => {
    signal?.throwIfAborted();
    if (disposed) throw new Error("LSP session has ended");
    const key = JSON.stringify([cwd, external]);
    let ready = managers.get(key);
    if (ready?.controller.signal.aborted) {
      await waitWithSignal(
        ready.promise.catch(() => undefined),
        signal,
      );
      if (managers.get(key) === ready) managers.delete(key);
      return managerFor(cwd, external, signal);
    }
    if (!ready) {
      ready = new SharedStartup(async (startupSignal) => {
        const registry = owner
          ? await owner.loadRegistry(cwd, external, startupSignal)
          : await loadRegistry(cwd, external, startupSignal);
        startupSignal.throwIfAborted();
        if (disposed) throw new Error("LSP session has ended");
        return LspManager.init(registry, owner?.workspace(cwd));
      });
      const pending = ready;
      managers.set(key, pending);
      void pending.promise.catch(() => {
        if (managers.get(key) === pending) managers.delete(key);
      });
    }
    return ready.wait(signal);
  };
  const resolveLspProject = async (filePath: string, cwd: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (owner) return owner.resolveProject(filePath, cwd, signal);
    const projectRoot = await resolveExternalToolProjectRoot(
      cwd,
      filePath,
      "lsp-servers",
      LSP_RECIPES,
      signal,
    );
    signal?.throwIfAborted();
    return projectRoot === undefined
      ? undefined
      : { cwd: projectRoot, external: projectRoot !== path.resolve(cwd) };
  };

  const managerForFile = async (
    cwd: string,
    filePath?: string,
    signal?: AbortSignal,
  ): Promise<LspManager> => {
    signal?.throwIfAborted();
    if (!filePath) return managerFor(cwd, false, signal);
    const project = await resolveLspProject(filePath, cwd, signal);
    signal?.throwIfAborted();
    if (!project) throw new Error("No language server project for this source");
    return managerFor(project.cwd, project.external, signal);
  };
  const compiler = {
    ...createLspCompiler(managerForFile),
    name: "pi-agent-ide-lsp",
    priority: 200,
  } satisfies IdeTool;
  const idePlugin = {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "lsp",
    setup(api): void {
      api.addTool(compiler);

      api.addDiagnosticSource(createLspDiagnosticSource(managerFor, resolveLspProject));
    },
  } satisfies IdePlugin;
  pi.on("session_shutdown", async () => {
    disposed = true;
    await Promise.allSettled(
      [...managers.values()].map(async (ready) => {
        if (!ready.settled) ready.controller.abort(new Error("LSP session has ended"));
        await (await ready.promise).shutdownAll();
      }),
    );
    managers.clear();
  });

  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "lsp",
    setup(api) {
      api.addResolver({
        resolver: createLspSymbolResolver(managerForFile),
        renderResult: renderReadResult,
      });
      api.addResolver({
        resolver: createLspGraphResolver(managerForFile),
        renderResult: renderReadResult,
      });
      api.addHandler({
        stage: "read",
        when: { resolvedBy: "any", contentKind: "text" },
        handler: createSourceMappedTextReadHandler(),
      });
      api.describe({
        path: "symbol:<file>#<selector> — declaration source, e.g. symbol:src/catalog.ts#Catalog/find. graph:<file> — top-level declarations, references and calls; members include selectors. graph:<file>#<selector> — references and incoming/outgoing calls for that declaration or member.",
      });
    },
  } satisfies ReadPlugin;

  await Promise.all([
    connectIdePlugin(pi, idePlugin),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "lsp-declarations",
      setup(api) {
        api.onDidEdit(async (completion) => {
          await Promise.all(
            [...managers.values()]
              .filter((ready) => ready.settled)
              .map((ready) =>
                ready.promise.then(
                  (manager) =>
                    manager.syncEditedSource(completion.source, completion.after.content),
                  () => undefined,
                ),
              ),
          );
        });
        api.addAnchorResolver({
          kind: TEXT_SEARCH_ANCHOR_KIND,
          type: "auxiliary",
          resolver: {
            id: "lsp-declaration",
            description:
              "symbol:<file>#<selector> selects an exact declaration for text fallback editing; imports and references are not rewritten.",
            renderFull: (value) => value,
            renderCompact: (value) => value,
            tryResolve: () => Promise.resolve({ kind: "not-handled" }),
          },
          resources: createDeclarationTargets(managerForFile),
          describeInPrompt: false,
        });
        for (const operation of ["copy", "move", "delete", "replace"]) {
          api
            .tool(operation)
            .describe(
              "Use symbol:<file>#<selector> as path to select one exact declaration without start/end. Use parent/child for ambiguous names. Copy/move require an explicit target and destination anchor. This text fallback leaves imports and references unchanged; it is not semantic rename." +
                (operation === "replace"
                  ? " Use symbol:<file>#<selector>#name with text containing the new name for native LSP rename across references. Omit start/end. A failed server rename never falls back to identifier text replacement."
                  : ""),
            );
          api.tool(operation).addHandler({
            stage: "text-pre-edit",
            async handler(state) {
              if (operation === "replace") {
                const renamed = await prepareSymbolRename(state, managerForFile);
                if (renamed !== undefined) return renamed;
              }
              const input = state.input as Record<string, unknown>;
              const selected = [
                input.path,
                input.start,
                input.end,
                input.target,
                input.targetStart,
                input.targetEnd,
              ].some((value) => typeof value === "string" && value.startsWith("symbol:"));
              if (!selected) return state;
              if (
                (operation === "copy" || operation === "move") &&
                typeof input.target !== "string"
              )
                throw new Error(
                  "Copying or moving a symbol requires an explicit target file and destination anchor.",
                );
              return {
                ...state,
                metadata: {
                  ...state.metadata,
                  semanticEdit: {
                    mode: "declaration-text",
                    referencesUpdated: false,
                    importsUpdated: false,
                  },
                  diffStatuses: [
                    { text: "Text fallback: imports and references unchanged", tone: "warning" },
                  ],
                },
              };
            },
          });
        }
        api
          .tool("insert")
          .describe(
            "Symbol targets are unsupported for insert. Read the declaration and select an ordinary text line anchor instead.",
          );
        api.tool("insert").addHandler({
          stage: "text-pre-edit",
          handler(state) {
            const input = state.input as Record<string, unknown>;
            if (
              [input.path, input.anchor].some(
                (value) => typeof value === "string" && value.startsWith("symbol:"),
              )
            )
              throw new Error(
                "Semantic insert is not supported. Read the declaration and use an explicit text line anchor instead.",
              );
            return state;
          },
        });
      },
    }),
    connectReadPlugin(pi, readPlugin),
    connectDoctorPlugin(pi, lspDoctorPlugin),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "symbols",
      setup(api): void {
        api.addResolver({
          resolver: createLspSearchResolver(managerForFile, api.registerSelection),
        });
        api.describe(
          'Use `symbols:<query>` to locate named workspace declarations and references through configured language servers when the file is unknown. Results contain exact source targets, roles, and originating symbols. Default search stays within path. Use navigation: "references" explicitly to follow symbols represented inside path to references outside it, within the workspace.',
        );
      },
    }),
  ]);
}

async function loadRegistry(
  cwd: string,
  external: boolean,
  signal?: AbortSignal,
): Promise<LspServerRegistry> {
  const configDirectory = external ? cwd : (process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd);
  return LspServerRegistry.fromPackageDir(configDirectory, {
    signal,
    includeGlobal: !external,
    requireBuiltInEvidence: external,
    recipes: LSP_RECIPES,
  });
}
