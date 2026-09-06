import path from "node:path";

import {
  addDiagnosticAnnotations,
  diagnosticStatus,
  createDiagnosticViewContent,
  createSourceMappedTextReadHandler,
  formatDiagnosticViewSource,
  resolveDiagnosticViewPath,
} from "pi-agent-ide/api/code-view";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import {
  IDE_API_VERSION,
  IDE_PROTOCOL,
  type IdePlugin,
  type IdePluginApi,
} from "pi-agent-ide/api/plugin-protocol";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResourceResolutionAttempt, ResourceResolver } from "pi-agent-resource";
import type { TextDocument, TextLinePresenter } from "pi-agent-text";
import type { ReadRequest } from "pi-agent-read/api/tools/read";

const DIAGNOSTIC_SCHEME = "diagnostics";
const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "Diagnostics" });

type ReadDiagnostics = IdePluginApi["readDiagnostics"];

export default async function registerDiagnostics(pi: ExtensionAPI): Promise<void> {
  let readDiagnostics: ReadDiagnostics | undefined;
  const collect = (filePath: string, cwd: string) => {
    if (readDiagnostics === undefined) {
      throw new Error("IDE diagnostics are not connected");
    }

    return readDiagnostics(filePath, { cwd });
  };
  const idePlugin = {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
    id: "diagnostics",
    setup(api): void {
      readDiagnostics = api.readDiagnostics;
    },
  } satisfies IdePlugin;
  // Keep readiness outside source-line projection, including empty and ranged reads.
  const documents = new WeakMap<ReadRequest, TextDocument>();
  const statuses = new WeakMap<TextDocument, string>();
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "diagnostics",
    setup(api) {
      api.addResolver({
        resolver: createDiagnosticResolver(collect),
        renderResult: renderReadResult,
      });
      const mapSource = createSourceMappedTextReadHandler();
      api.addView({
        view: "diagnostics",
        priority: 100,
        presenter: createDiagnosticPresenter(collect, statuses),
      });
      api.addHandler({
        stage: "read",
        when: { resolvedBy: "any", contentKind: "text" },
        handler(context) {
          if (context.state?.resolvedBy === "diagnostics") return mapSource(context);
          if (
            context.state?.contentKind === "text" &&
            context.request.views?.includes("diagnostics")
          ) {
            documents.set(context.request, context.state.text);
          }
          return { kind: "continue", context };
        },
      });
      api.addHandler({
        stage: "post-read",
        handler(context) {
          const document = documents.get(context.request);
          const status = document && statuses.get(document);
          const result = context.result;
          const first = result?.content[0];
          if (!status || !result || first?.type !== "text") return { kind: "continue", context };
          return {
            kind: "continue",
            context: {
              ...context,
              result: {
                ...result,
                content: [
                  { ...first, text: `${status}\n${first.text}` },
                  ...result.content.slice(1),
                ],
              },
            },
          };
        },
      });
      api.describe(
        "`diagnostics:<path>` returns lint and LSP diagnostics with five lines of source context on each side. The `diagnostics` view adds the same diagnostics alongside a normal file read. Both reuse background results, wait briefly for current checks, and report pending, unavailable, snapshot, or unversioned sources explicitly. A snapshot is the latest push update, not a completed check; an empty snapshot does not mean the file is clean.",
      );
      api.addPromptGuideline(
        "Use read with `diagnostics:<path>` or the `diagnostics` view for per-file diagnostics instead of running equivalent checks through Bash. Project builds and tests remain separate verification.",
      );
      api.addPromptGuideline(
        'You can use read with `views: ["diagnostics"]` to add lint and LSP diagnostics alongside file content.',
      );

      api.addPromptGuideline(
        "Treat diagnostic snapshots as incomplete observations, not completed checks; an empty snapshot is not evidence that the file is clean.",
      );
    },
  } satisfies ReadPlugin;

  await Promise.all([connectIdePlugin(pi, idePlugin), connectReadPlugin(pi, readPlugin)]);
}

function createDiagnosticResolver(collect: CollectDiagnostics): ResourceResolver {
  return {
    id: "diagnostics",
    tryResolve(source, context) {
      return Promise.resolve(resolveDiagnosticSource(source, context.cwd, collect));
    },
  };
}

type CollectDiagnostics = (
  filePath: string,
  cwd: string,
) => ReturnType<IdePluginApi["readDiagnostics"]>;

function resolveDiagnosticSource(
  source: string,
  cwd: string,
  collect: CollectDiagnostics,
): ResourceResolutionAttempt {
  let filePath: string | undefined;

  try {
    filePath = resolveDiagnosticViewPath(source, DIAGNOSTIC_SCHEME, cwd);
  } catch (error) {
    return { kind: "failed", error };
  }

  if (filePath === undefined) {
    return { kind: "not-handled" };
  }

  return {
    kind: "resolved",
    resource: {
      source: formatDiagnosticViewSource(DIAGNOSTIC_SCHEME, filePath),
      async read() {
        const snapshot = await collect(filePath, cwd);
        return [createDiagnosticViewContent(filePath, snapshot.content, snapshot.results)];
      },
    },
  };
}

function createDiagnosticPresenter(
  collect: CollectDiagnostics,
  statuses: WeakMap<TextDocument, string>,
): TextLinePresenter {
  return {
    id: "diagnostics",
    async present(document, context) {
      if (context.purpose !== "read" || !path.isAbsolute(document.source)) {
        return document;
      }

      const snapshot = await collect(document.source, context.cwd);
      if (snapshot.content !== document.content) {
        throw new Error(
          "File changed during diagnostic read; read it again for current source lines.",
        );
      }
      statuses.set(document, diagnosticStatus(snapshot.results));
      return addDiagnosticAnnotations(document, snapshot.results);
    },
  };
}
