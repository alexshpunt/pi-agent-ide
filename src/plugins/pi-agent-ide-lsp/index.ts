import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { createSourceMappedTextReadHandler } from "pi-agent-ide/api/code-view";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
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

import { createLspGraphResolver, createLspSymbolResolver } from "./src/code-view-resolvers.js";
import { createLspDiagnosticSource } from "./src/diagnostic-source.js";
import { lspDoctorPlugin } from "./src/doctor-plugin.js";
import { createLspCompiler, LspManager, LspServerRegistry } from "./src/lsp/index.js";
import { createLspSearchResolver } from "./src/search-resolver.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "LSP" });

export default async function registerLsp(pi: ExtensionAPI): Promise<void> {
  const managers = new Map<string, Promise<LspManager>>();
  let disposed = false;
  const managerFor = (cwd: string): Promise<LspManager> => {
    if (disposed) return Promise.reject(new Error("LSP session has ended"));
    let ready = managers.get(cwd);
    if (!ready) {
      ready = loadRegistry(cwd).then((registry) => {
        if (disposed) throw new Error("LSP session has ended");
        return LspManager.init(registry);
      });
      managers.set(cwd, ready);
    }
    return ready;
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

      api.addDiagnosticSource(createLspDiagnosticSource(managerFor));
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
        "Provides `symbol:<path>#<selector>` for a symbol's implementation, `graph:<path>` for relationships of top-level declarations, and `graph:<path>#<selector>` for one symbol's relationships.",
      );

      api.addPromptGuideline(
        "You can use read with `symbol:<path>#<selector>` to inspect a known symbol's implementation without searching for it or reading the whole file.",
      );
      api.addPromptGuideline(
        "You can use read with `graph:<path>` to inspect each top-level declaration's definition, referencing files, and incoming and outgoing calls. Members are listed with selectors; their relationships are not expanded. You can append `#<selector>` to inspect one symbol's references and calls, including a nested method.",
      );
    },
  } satisfies ReadPlugin;

  await Promise.all([
    connectIdePlugin(pi, idePlugin),
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

        api.addPromptGuideline(
          "You can use search with `symbols:<query>` to find workspace symbols and their references through configured language servers.",
        );
      },
    }),
  ]);
}

async function loadRegistry(cwd: string): Promise<LspServerRegistry> {
  const configDirectory = process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd;
  return LspServerRegistry.fromPackageDir(configDirectory);
}
