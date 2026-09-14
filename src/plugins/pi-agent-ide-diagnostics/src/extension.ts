import path from "node:path";
import { hasDeferredPostEdit } from "pi-agent-text-editor/api/post-edit";

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
  type IdeDiagnosticReadContext,
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
import type { ReadRequest, ReadResultDetails } from "pi-agent-read/api/tools/read";

const DIAGNOSTIC_SCHEME = "diagnostics";
const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "Diagnostics" });

type ReadDiagnostics = IdePluginApi["readDiagnostics"];

export default async function registerDiagnostics(pi: ExtensionAPI): Promise<void> {
  let readDiagnostics: ReadDiagnostics | undefined;
  const collect: CollectDiagnostics = (filePath, cwd, options) => {
    if (readDiagnostics === undefined) {
      throw new Error("IDE diagnostics are not connected");
    }

    return readDiagnostics(filePath, { cwd, ...options });
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
  const checks = new WeakMap<ReadRequest, NonNullable<ReadResultDetails["diagnosticCheck"]>>();
  const contents = new WeakMap<object, NonNullable<ReadResultDetails["diagnosticCheck"]>>();
  const documents = new WeakMap<ReadRequest, TextDocument>();
  const statuses = new WeakMap<TextDocument, string>();
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "diagnostics",
    setup(api) {
      api.addResolver({
        resolver: createDiagnosticResolver(collect, contents),
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
          if (context.state?.resolvedBy === "diagnostics") {
            const content = context.state.content[0];
            const check = contents.get(content);
            if (check) checks.set(context.request, check);
            return mapSource(context);
          }
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
          const check = checks.get(context.request);
          if (check && context.result) {
            return {
              kind: "continue",
              context: {
                ...context,
                result: {
                  ...context.result,
                  details: { ...context.result.details, diagnosticCheck: check },
                },
              },
            };
          }
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
        'diagnostics:<path> — lint and language-server diagnostics. views: ["diagnostics"] — diagnostics alongside source text. Diagnostic sources name the actual reporting tools. Automatic notices include findings only and wake an idle agent after the notification buffer (five seconds by default); silence does not prove the file is clean. Use an explicit diagnostic read to check readiness. Pending results and snapshots are not completed checks; an empty snapshot does not prove the file is clean.',
      );
      api.addPromptGuideline(
        "Use read with `diagnostics:<path>` or the `diagnostics` view for per-file diagnostics instead of running equivalent checks through Bash. Project builds and tests remain separate verification.",
      );
    },
  } satisfies ReadPlugin;

  await Promise.all([connectIdePlugin(pi, idePlugin), connectReadPlugin(pi, readPlugin)]);
}

function createDiagnosticResolver(
  collect: CollectDiagnostics,
  contents: WeakMap<object, NonNullable<ReadResultDetails["diagnosticCheck"]>>,
): ResourceResolver {
  return {
    id: "diagnostics",
    tryResolve(source, context) {
      return Promise.resolve(
        resolveDiagnosticSource(source, context.cwd, collect, contents, {
          signal: context.signal,
          ...(context.audience === "script" && { mode: "complete" }),
        }),
      );
    },
  };
}

type CollectDiagnostics = (
  filePath: string,
  cwd: string,
  options?: Omit<IdeDiagnosticReadContext, "cwd">,
) => ReturnType<IdePluginApi["readDiagnostics"]>;

function resolveDiagnosticSource(
  source: string,
  cwd: string,
  collect: CollectDiagnostics,
  contents: WeakMap<object, NonNullable<ReadResultDetails["diagnosticCheck"]>>,
  options?: Omit<IdeDiagnosticReadContext, "cwd">,
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
        const snapshot = await collect(filePath, cwd, options);
        const content = createDiagnosticViewContent(filePath, snapshot.content, snapshot.results);
        contents.set(content, content.diagnosticCheck);
        return [content];
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

      const eager =
        context.audience === "script" && !context.requestedViews?.includes("diagnostics");
      if (eager && hasDeferredPostEdit(document.source)) return document;
      const snapshot = await collect(document.source, context.cwd, {
        signal: context.signal,
        ...(context.audience === "script" && {
          mode: eager ? "snapshot" : "complete",
        }),
      }).catch((error: unknown) => {
        context.signal?.throwIfAborted();
        if (eager) return undefined;
        throw error;
      });
      // Listings and converted documents are not the file's diagnostic source text.
      // Optional enrichment must not reject an otherwise successful read.
      if (snapshot === undefined || (eager && snapshot.content !== document.content))
        return document;
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
