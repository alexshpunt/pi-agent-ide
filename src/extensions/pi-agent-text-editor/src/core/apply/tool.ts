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
import { executeApplySource } from "#src/core/apply/runtime.js";
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
    promptSnippet: "Compose dependent IDE reads and edits in one JavaScript call",
    description:
      "Use apply to combine IDE operations with JavaScript loops and conditions. Direct synchronous functions (no await): read, search, diff, write, replace, insert, remove (delete), copy, move, delete_file, copy_file, move_file, undo, stage, unstage. Pass the same argument objects as standalone tools. Calls execute sequentially, including Promise.all. Text reads return source, raw content and lines with anchors and view metadata. Multi-resource reads return resources; native reads return blocks. Search returns resolverId, raw data and registered selection details. Ordinary reads do not wait for diagnostics; explicit diagnostics requests wait for completed checks and throw if unavailable or timed out. Mutations return final file data. Use result(value) to select extra output; return is not required. Mutations suppress automatic read output. Final per-file changes use the same result format as standalone edits. Applied changes survive errors; catch operation errors by code/details. Output has one 2000-line/50KB budget. Overflow uses compact source views or a summary with a full temp reference. No shell, imports or resume. Undo restores one selected file transaction or Git change, never the whole Apply call." +
      applyHelperGuide,
    promptGuidelines: [
      "Use apply for dependent combinations of IDE operations. Use standalone tools for a single operation. Check reported effects before retrying a failed apply; earlier edits are not rolled back.",
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
        await executeApplySource(source, execution.host, signal);
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
      return {
        content: output.content,
        details: {
          failed,
          displaySource: await displaySource,
          outputLevel: output.level,
          display: createApplyDisplay(execution.results, output, error, context.cwd),
          temporarySource: output.temporarySource,
          files: execution.results.select().files.map(({ source: file }) => file),
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
