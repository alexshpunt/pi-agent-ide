import { readFile } from "node:fs/promises";
import path from "node:path";

import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import {
  createDiagnosticViewContent,
  createSourceMappedTextReadHandler,
  formatDiagnosticViewSource,
  resolveDiagnosticViewPath,
} from "pi-agent-ide/api/code-view";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";
import { type Diagnostic, formatDiagnostic, type IdeTool } from "pi-agent-ide/api/toolchain";
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
import { lspDoctorPlugin } from "./src/doctor-plugin.js";
import { createLspCompiler, LspManager, LspServerRegistry } from "./src/lsp/index.js";
import { createLspSearchResolver } from "./src/search-resolver.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResourceResolutionAttempt, ResourceResolver } from "pi-agent-resource";
import type { TextDocument, TextLinePresenter } from "pi-agent-text";

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "LSP" });

export default async function registerLsp(pi: ExtensionAPI): Promise<void> {
  let managerCwd: string | undefined;
  let managerReady: Promise<LspManager> | undefined;
  const managerFor = (cwd: string): Promise<LspManager> => {
    if (managerReady === undefined || managerCwd !== cwd) {
      managerCwd = cwd;
      managerReady = loadRegistry(cwd).then((registry) => LspManager.init(registry));
    }

    return managerReady;
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
    },
  } satisfies IdePlugin;
  pi.on("session_shutdown", async () => {
    await LspManager.getInstanceOrNull()?.shutdownAll();
  });

  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "lsp",
    setup(api) {
      api.addResolver({
        resolver: createLspDiagnosticResolver(managerFor),
        renderResult: renderReadResult,
      });
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
      api.addTextPresenter({
        priority: 100,
        presenter: createLspReadPresenter(managerFor),
      });
      api.describe(
        "Adds LSP diagnostics to normal file reads. Use `lsp:<path>` to read only lines with LSP errors, `symbol:<path>#<selector>` to read a specific symbol's implementation, and `graph:<path>` or `graph:<path>#<selector>` to inspect dependencies and relationships across files.",
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
      id: "lsp-search",
      setup(api): void {
        api.addResolver({ resolver: createLspSearchResolver(managerFor) });
        api.describe(
          "Use `lsp:<symbol>` to search workspace symbols and their references through configured language servers.",
        );
      },
    }),
  ]);
}

function createLspDiagnosticResolver(
  getManager: (cwd: string) => Promise<LspManager>,
): ResourceResolver {
  return {
    id: "lsp-diagnostics",
    tryResolve(source, context) {
      return Promise.resolve(resolveLspDiagnosticSource(source, context.cwd, getManager));
    },
  };
}

function resolveLspDiagnosticSource(
  source: string,
  cwd: string,
  getManager: (cwd: string) => Promise<LspManager>,
): ResourceResolutionAttempt {
  let filePath: string | undefined;

  try {
    filePath = resolveDiagnosticViewPath(source, "lsp", cwd);
  } catch (error) {
    return { kind: "failed", error };
  }

  if (filePath === undefined) {
    return { kind: "not-handled" };
  }

  return {
    kind: "resolved",
    resource: {
      source: formatDiagnosticViewSource("lsp", filePath),
      async read() {
        const [text, manager] = await Promise.all([readFile(filePath, "utf8"), getManager(cwd)]);
        const compiled = await createLspCompiler(manager).compile({ filePath }, { cwd });
        return [createDiagnosticViewContent(filePath, text, compiled.syntaxErrors, "lsp")];
      },
    },
  };
}

function createLspReadPresenter(
  getManager: (cwd: string) => Promise<LspManager>,
): TextLinePresenter {
  return {
    id: "lsp-diagnostics",
    async present(document, context) {
      const source = document.source;

      if (context.purpose !== "read" || !path.isAbsolute(source)) {
        return document;
      }

      try {
        const manager = await getManager(context.cwd);
        const compiled = await createLspCompiler(manager).compile(
          { filePath: source },
          { cwd: context.cwd },
        );
        return addDiagnostics(document, compiled.diagnostics, "lsp");
      } catch {
        return document;
      }
    },
  };
}

function addDiagnostics(
  document: TextDocument,
  diagnostics: readonly Diagnostic[],
  source: string,
): TextDocument {
  const diagnosticsByLine = new Map<number, string[]>();

  for (const diagnostic of diagnostics) {
    const annotations = diagnosticsByLine.get(diagnostic.line) ?? [];
    annotations.push(`<!-- ${source}: ${formatDiagnostic(diagnostic, source)} -->`);
    diagnosticsByLine.set(diagnostic.line, annotations);
  }

  if (diagnosticsByLine.size === 0) {
    return document;
  }

  const lines = document.lines.map((line) => {
    const annotations = diagnosticsByLine.get(line.lineNumber);

    if (annotations === undefined) {
      return line;
    }

    return {
      ...line,
      presentation: {
        ...line.presentation,
        suffix: `${line.presentation?.suffix ?? ""}  ${annotations.join(" ")}`,
      },
    };
  });

  return { ...document, lines };
}

async function loadRegistry(cwd: string): Promise<LspServerRegistry> {
  const configDirectory = process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd;
  return LspServerRegistry.fromPackageDir(configDirectory);
}
