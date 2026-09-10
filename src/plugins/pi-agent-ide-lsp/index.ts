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

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "LSP" });

export default async function registerLsp(pi: ExtensionAPI): Promise<void> {
  const managers = new Map<string, Promise<LspManager>>();
  let disposed = false;
  const managerFor = (cwd: string, external = false): Promise<LspManager> => {
    if (disposed) return Promise.reject(new Error("LSP session has ended"));
    const key = JSON.stringify([cwd, external]);
    let ready = managers.get(key);
    if (!ready) {
      ready = loadRegistry(cwd, external).then((registry) => {
        if (disposed) throw new Error("LSP session has ended");
        return LspManager.init(registry);
      });
      managers.set(key, ready);
    }
    return ready;
  };
  const resolveLspProject = async (filePath: string, cwd: string) => {
    const projectRoot = await resolveExternalToolProjectRoot(
      cwd,
      filePath,
      "lsp-servers",
      LSP_RECIPES,
    );
    return projectRoot === undefined
      ? undefined
      : { cwd: projectRoot, external: projectRoot !== path.resolve(cwd) };
  };

  const compiler = {
    kind: "compiler",
    name: "pi-agent-ide-lsp",
    priority: 200,
    extensions: ["*"],
    detect: async (context) => {
      await managerFor(context.cwd);
      return true;
    },
    async compile(input, context) {
      const manager = await managerFor(context.cwd);
      return createLspCompiler(manager).compile(input, context);
    },
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
      [...managers.values()].map(async (ready) => (await ready).shutdownAll()),
    );
    managers.clear();
  });

  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "lsp",
    setup(api) {
      api.addResolver({
        resolver: createLspSymbolResolver(managerFor),
        renderResult: renderReadResult,
      });
      api.addResolver({
        resolver: createLspGraphResolver(managerFor),
        renderResult: renderReadResult,
      });
      api.addHandler({
        stage: "read",
        when: { resolvedBy: "any", contentKind: "text" },
        handler: createSourceMappedTextReadHandler(),
      });
      api.describe(
        "symbol:<file>#<selector> — declaration source, e.g. symbol:src/catalog.ts#Catalog/find. graph:<file> — top-level declarations, references and calls; members include selectors. graph:<file>#<selector> — references and incoming/outgoing calls for that declaration or member.",
      );
    },
  } satisfies ReadPlugin;

  await Promise.all([
    connectIdePlugin(pi, idePlugin),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "lsp-declarations",
      setup(api) {
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
          resources: createDeclarationTargets(managerFor),
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
                const renamed = await prepareSymbolRename(state, managerFor);
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
        api.addResolver({ resolver: createLspSearchResolver(managerFor) });
        api.describe(
          "Use `symbols:<query>` to search workspace symbols and their references through configured language servers.",
        );
      },
    }),
  ]);
}

async function loadRegistry(cwd: string, external: boolean): Promise<LspServerRegistry> {
  const configDirectory = external ? cwd : (process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd);
  return LspServerRegistry.fromPackageDir(configDirectory, {
    includeGlobal: !external,
    requireBuiltInEvidence: external,
    recipes: LSP_RECIPES,
  });
}
