import { formatApplySource } from "./format-source.js";
import { applyHelperGuide } from "#src/core/apply/prompt.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPluginApi,
} from "pi-agent-read/api/plugin-protocol";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import type { SearchPluginApi } from "pi-agent-search/api/search";
import { Type } from "typebox";
import {
  getLastResolvedResource,
  rememberLastResolvedResource,
} from "#src/api/last-resolved-resource.js";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import { createApplyExecution } from "#src/core/apply/execution.js";
import { executeApplySource, getApplyOperations } from "#src/core/apply/runtime.js";
import { renderApplyOutput } from "#src/core/apply/output.js";
import {
  createApplyDisplay,
  renderApplyCall,
  renderApplyResult,
} from "#src/core/apply/renderer.js";

/** Registers composed IDE operations using the owning extensions' configured services. */
export async function registerApply(pi: ExtensionAPI, editor: TextEditorCore): Promise<void> {
  let read: ReadPluginApi | undefined;
  let search: SearchPluginApi | undefined;
  await connectReadPlugin(pi, {
    id: "apply",
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    setup(api) {
      read = api;
    },
  });
  await connectSearchPlugin(pi, {
    id: "apply",
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    setup(api) {
      search = api;
    },
  });
  const operations = getApplyOperations();
  pi.registerTool({
    name: "apply",
    label: "Apply",
    renderShell: "self",
    renderCall: (args, theme, context) => {
      (context.state as { codeView?: boolean }).codeView =
        pi.getFlag("pi-agent-ide-apply-code") === true;
      const render = editor.getToolRenderer("apply")?.renderCall ?? renderApplyCall;
      return render(args, theme, context);
    },
    renderResult: (...args) => {
      const render = (editor.getToolRenderer("apply")?.renderResult ??
        renderApplyResult) as typeof renderApplyResult;
      return render(...args);
    },
    promptSnippet: "Compose guarded multi-file editor transactions with JavaScript",
    description:
      `Use apply to compose read-only IDE operations and snapshot-guarded editor transactions in JavaScript. Read-only functions: read, search, diff, result. Editor functions: open, createFile, deleteFile, copyFile, moveFile, apply. Mutations are staged until apply() commits them. Calls execute sequentially. Output has one 2000-line/50KB budget. No shell, imports or resume.` +
      applyHelperGuide(),
    promptGuidelines: [
      "Use Apply for complex, multi-file changes. Open immutable file snapshots, select exact text or lines, stage guarded operations, then call apply() explicitly. Use standalone editor tools for small precise edits.",
      "Do not call result() merely to display reads or committed file changes; Apply reports them automatically. Use result(value) only for additional calculated data.",
    ],
    parameters: Type.Object({
      source: Type.String({
        description:
          "JavaScript function body. Call IDE functions directly without await; each call finishes before the next statement. Use result(value) for explicit output. The UI may compact written tool calls or format a display copy; execution uses this source unchanged.",
      }),
    }),
    async execute(_id, { source }, signal, _onUpdate, context) {
      if (read === undefined || search === undefined)
        throw new Error("Apply requires the read and search extensions");
      const execution = createApplyExecution(
        {
          editor,
          read,
          search,
          lastResolvedSource: getLastResolvedResource(pi)?.source,
          rememberRead: (outcome) => rememberLastResolvedResource(pi, outcome.details),
        },
        context,
      );
      const displaySource = formatApplySource(source);
      let failed = false;
      let error: unknown;
      try {
        await executeApplySource(source, execution.host, signal, undefined, operations);
      } catch (cause) {
        failed = true;
        error = cause;
      }
      try {
        await execution.finish();
      } catch (cause) {
        failed = true;
        error ??= cause;
      }
      const output = await renderApplyOutput(execution.results, read, error, {
        cwd: context.cwd,
        signal,
      });
      const transactions = execution.results
        .mutationValues()
        .flatMap((value) =>
          value !== null &&
          typeof value === "object" &&
          "transaction" in value &&
          typeof value.transaction === "string" &&
          editor.hasApplyUndo(value.transaction)
            ? [value.transaction]
            : [],
        );
      const content = [
        ...output.content,
        ...transactions.map((transaction) => ({
          type: "text" as const,
          text: `Undo transaction: ${transaction}`,
        })),
      ];
      return {
        content,
        details: {
          failed,
          displaySource: await displaySource,
          outputLevel: output.level,
          display: createApplyDisplay(execution.results, output, error, context.cwd),
          temporarySource: output.temporarySource,
          files: execution.results.select().files.map(({ source: file }) => file),
          transactions,
        },
      };
    },
  });
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "apply" &&
      event.details &&
      typeof event.details === "object" &&
      "failed" in event.details &&
      event.details.failed
    )
      return { isError: true };
    return;
  });
}
