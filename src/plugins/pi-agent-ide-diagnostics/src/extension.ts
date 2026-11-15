import { randomUUID } from "node:crypto";
import path from "node:path";
import { hasDeferredPostEdit } from "pi-agent-text-editor/api/post-edit";

import {
  addDiagnosticAnnotations,
  diagnosticStatus,
  createDiagnosticViewContent,
  resolveCodeViewPath,
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
import { connectResultTargets, trackScriptCalls } from "pi-agent-resource";
import { Type } from "typebox";
import { toolCallHeader } from "pi-agent-tool-ui";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import type { TextDocument, TextLinePresenter } from "pi-agent-text";
import {
  readOutputSchema,
  createReadResultTargetHandler,
  structuredRead,
  type ReadRequest,
  type ReadToolPluginApi,
} from "pi-agent-read/api/tools/read";

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "Diagnostics" });

type ReadDiagnostics = IdePluginApi["readDiagnostics"];

export default async function registerDiagnostics(pi: ExtensionAPI): Promise<void> {
  const reports = new Map<string, string>();
  pi.on("session_start", () => reports.clear());
  pi.on("session_shutdown", () => reports.clear());
  const targets = connectResultTargets(pi);
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
  let readApi: ReadToolPluginApi | undefined;
  const documents = new WeakMap<ReadRequest, TextDocument>();
  const statuses = new WeakMap<TextDocument, string>();
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "diagnostics",
    setup(api) {
      readApi = api;
      const retainReport = createReadResultTargetHandler(
        targets,
        api.read,
        (source) => reports.has(source),
        "Diagnostic reports are read-only. Read the source file to edit it.",
      );
      api.addResolver({
        resolver: {
          id: "diagnostic-reports",
          async tryResolve(source) {
            const text = reports.get(source);
            if (text === undefined) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                sourceBytes: new TextEncoder().encode(text),
                async read() {
                  return [{ type: "text", text }];
                },
              },
            };
          },
        },
      });
      api.addView({
        view: "diagnostics",
        priority: 100,
        presenter: createDiagnosticPresenter(collect, statuses),
      });
      api.addHandler({
        stage: "read",
        when: { resolvedBy: "any", contentKind: "text" },
        handler(context) {
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
          if (context.state && reports.has(context.state.source)) return retainReport(context);
          const document = documents.get(context.request);
          const status = document && statuses.get(document);
          const result = context.result;
          const first = result?.content[0];
          if (!status || !result || first?.type !== "text") return { kind: "continue", context };
          return {
            kind: "continue",
            context,
            transform(updated) {
              const first = updated.content[0];
              if (first?.type !== "text") return updated;
              return {
                ...updated,
                content: [
                  { ...first, text: `${status}\n${first.text}` },
                  ...updated.content.slice(1),
                ],
                details: { ...updated.details, diagnosticStatus: status },
              };
            },
          };
        },
      });
      api.describe({
        views: "diagnostics — diagnostics beside the text.",
      });
    },
  } satisfies ReadPlugin;

  await Promise.all([connectIdePlugin(pi, idePlugin), connectReadPlugin(pi, readPlugin)]);
  const scriptCall = trackScriptCalls(pi, "diagnostics");
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "diagnostics",
        label: "diagnostics",
        exposure: "direct",
        namespace: {
          name: "ide_diagnostics",
          description: "Check file diagnostics from lint and language servers.",
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Check lint and language-server diagnostics for a file, with nearby source context and check readiness. Returns a report reusable by Read and Search, not an editable source selection.",
        promptSnippet: "Check file diagnostics and lint/language-server readiness",
        parameters: Type.Object(
          {
            path: Type.String({
              minLength: 1,
              description: "Local file path or ssh:// file path.",
            }),
          },
          { additionalProperties: false },
        ),
        outputSchema: readOutputSchema,
        renderCall(parameters, theme, context) {
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "diagnostics",
              primary: { text: parameters.path, color: "accent", truncate: "start" },
              expanded: context.expanded,
            },
            theme,
          );
        },
        renderResult: renderReadResult,
        async execute(id, parameters, signal, onUpdate, context) {
          if (!readApi) throw new Error("diagnostics needs the Read module (read.core).");
          const filePath = resolveCodeViewPath(parameters.path, context.cwd);
          const script = scriptCall(id);
          const snapshot = await collect(filePath, context.cwd, { signal });
          const report = createDiagnosticViewContent(filePath, snapshot.content, snapshot.results);
          // Do not expose report sourceLines: they map preview context back to editable file text.
          const reportText = report.text.endsWith("\n") ? report.text : report.text + "\n";
          const source = `diagnostic-report:${randomUUID()}`;
          reports.set(source, reportText);
          const result = await readApi.read(
            { path: source },
            {
              cwd: context.cwd,
              signal,
              ...(onUpdate && { onUpdate }),
            },
            script ? "script" : "agent",
          );
          return structuredRead(
            {
              ...result,
              details: {
                ...result.details,
                // Presentation names the checked file; script targets remain on the report.
                source: filePath,
                diagnosticCheck: report.diagnosticCheck,
              },
            },
            { complete: script },
          );
        },
      },
      new ToolCallInterceptionRenderStore(),
    ),
  );
}

type CollectDiagnostics = (
  filePath: string,
  cwd: string,
  options?: Omit<IdeDiagnosticReadContext, "cwd">,
) => ReturnType<IdePluginApi["readDiagnostics"]>;

function createDiagnosticPresenter(
  collect: CollectDiagnostics,
  statuses: WeakMap<TextDocument, string>,
): TextLinePresenter {
  return {
    id: "diagnostics",
    async present(document, context) {
      if (
        context.purpose !== "read" ||
        (!path.isAbsolute(document.source) && !document.source.startsWith("ssh://"))
      ) {
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
