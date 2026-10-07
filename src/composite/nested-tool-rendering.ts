import {
  ToolExecutionComponent,
  type ExtensionAPI,
  type ToolDefinition,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import {
  NATIVE_EDIT_BATCH_EVENT,
  type NativeEditBatchEvent,
} from "#src/extensions/pi-agent-text-editor/src/api/native-edit-batch-event.js";
import { compactMutationDetails } from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/src/persisted-result.js";

const ENTRY_TYPE = "ide-nested-results";
const MAX_CALLS = 256;
const MAX_BYTES = 512 * 1024;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_ARGUMENT_TOTAL_BYTES = 32 * 1024;

interface ChildPanel {
  id: string;
  name: string;
  args: unknown;
  renderArgs?: unknown;
  omitted?: boolean;
  batched?: boolean;
  rollback?: boolean;
  postWriteFailure?: boolean;
  unchangedCopy?: boolean;
  copyRollback?: "restored" | "failed";
  result?: { content: AgentToolResult<unknown>["content"]; details: unknown; isError: boolean };
}
interface BatchReport {
  data?: { operations?: { id: string; effect: string; errors: { message: string }[] }[] };
}
interface PanelGroup {
  parentToolCallId: string;
  cwd: string;
  calls: ChildPanel[];
  complete: boolean;
}

/** Keep bounded display data for nested IDE tools, separate from model context and usage. */
export function createNestedIdeRendering(pi: ExtensionAPI) {
  const definitions = new Map<string, ToolDefinition>();
  const parents = new Map<string, string>();
  const groups = new Map<string, PanelGroup>();
  let tui: TUI | undefined;
  const components = new WeakMap<object, Container>();
  const retainResult = (
    group: PanelGroup,
    call: ChildPanel,
    result: NonNullable<ChildPanel["result"]>,
  ) => {
    // Bound in-memory display data as each call finishes, not only at persistence.
    call.result = result;
    try {
      const serialized = JSON.stringify(group);
      if (Buffer.byteLength(serialized) <= MAX_BYTES) {
        call.result = JSON.parse(JSON.stringify(result)) as NonNullable<ChildPanel["result"]>;
        return;
      }
    } catch {
      // A renderer payload that cannot be serialized must not break tool execution.
    }
    const references =
      result.details && typeof result.details === "object"
        ? Object.entries(result.details)
            .filter(
              ([key, value]) =>
                (key === "source" || key === "fullOutputPath") && typeof value === "string",
            )
            .map(([key, value]) => `${key}: ${String(value)}`)
        : [];
    call.result = {
      content: [
        {
          type: "text",
          text: [
            "Result presentation omitted (history size limit or unsupported payload).",
            ...references,
          ].join("\n"),
        },
      ],
      details: undefined,
      isError: result.isError,
    };
    call.omitted = true;
    group.complete = false;
  };
  const clear = () => {
    parents.clear();
    groups.clear();
  };
  pi.on("session_start", (_event, context) => {
    clear();
    if (context.mode !== "tui") return;
    // A zero-row widget supplies the public TUI handle needed by native tool components.
    context.ui.setWidget(ENTRY_TYPE, (ui) => {
      tui = ui;
      return {
        render: () => [],
        invalidate: () => {},
      };
    });
  });
  pi.on("session_tree", clear);
  pi.on("session_shutdown", clear);
  pi.on("tool_execution_start", (event, context) => {
    if (event.parentToolCallId === undefined) return;
    const root = parents.get(event.parentToolCallId) ?? event.parentToolCallId;
    parents.set(event.toolCallId, root);
    if (!definitions.has(event.toolName)) return;
    let group = groups.get(root);
    if (!group) {
      group = { parentToolCallId: root, cwd: context.cwd, calls: [], complete: true };
      groups.set(root, group);
    }
    if (group.calls.length >= MAX_CALLS) {
      group.complete = false;
      return;
    }
    const json = JSON.stringify(event.args);
    const remaining =
      MAX_ARGUMENT_TOTAL_BYTES -
      group.calls.reduce((bytes, call) => bytes + Buffer.byteLength(JSON.stringify(call.args)), 0);
    const omitted = Buffer.byteLength(json) > Math.min(MAX_ARGUMENT_BYTES, remaining);
    const args = omitted
      ? Object.fromEntries(
          Object.entries(event.args as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === "string"
              ? value.slice(0, 200) + (value.length > 200 ? "… [omitted]" : "")
              : "[omitted]",
          ]),
        )
      : (JSON.parse(json) as unknown);
    const boundedArgs = Buffer.byteLength(JSON.stringify(args)) <= remaining ? args : {};
    group.calls.push({ id: event.toolCallId, name: event.toolName, args: boundedArgs });
    if (omitted) group.complete = false;
  });
  pi.on("tool_execution_end", (event) => {
    const root = parents.get(event.toolCallId);
    if (root === undefined) return;
    parents.delete(event.toolCallId);
    const group = groups.get(root);
    const call = group?.calls.find((call) => call.id === event.toolCallId);
    if (group && call) {
      // Hooks have already prepared compact renderer details. Never copy structuredContent or usage.
      const result = event.result as AgentToolResult<unknown>;
      retainResult(group, call, {
        content: result.content.filter(
          (block) => block.type !== "text" || !block.text.startsWith("\n\n---\n\n# Guide:"),
        ),
        details: result.details,
        isError: event.isError,
      });
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "toolResult") return;
    const group = groups.get(event.message.toolCallId);
    if (!group) return;
    groups.delete(event.message.toolCallId);
    for (const [child, root] of parents) if (root === group.parentToolCallId) parents.delete(child);
    // Serializing once strips runtime classes and prevents later hooks from mutating history.
    const saved: PanelGroup = { ...group, calls: [], complete: group.complete };
    let bytes = 0;
    for (const call of group.calls) {
      if (call.batched) continue;
      const json = JSON.stringify(call);
      bytes += Buffer.byteLength(json);
      if (bytes > MAX_BYTES) {
        saved.complete = false;
        break;
      }
      saved.calls.push(JSON.parse(json) as ChildPanel);
      if (!call.result) saved.complete = false;
    }
    pi.appendEntry(ENTRY_TYPE, saved);
  });
  pi.registerEntryRenderer<PanelGroup>(ENTRY_TYPE, function renderEntry(entry, options, theme) {
    if (!Array.isArray(entry.data?.calls)) return undefined;
    // Pi rebuilds resumed history before session_start binds the public UI.
    // Keep the entry mounted and resolve its tool components on the next render.
    if (!tui)
      return {
        render: (width: number): string[] =>
          tui ? (renderEntry(entry, options, theme)?.render(width) ?? []) : [],
        invalidate: () => {
          if (entry.data) components.get(entry.data)?.invalidate();
        },
      };
    let panel = components.get(entry.data);
    if (!panel) {
      panel = new Container();
      for (const call of entry.data.calls) {
        const component = new ToolExecutionComponent(
          call.name,
          call.id,
          call.renderArgs ?? call.args,
          { showImages: true },
          call.omitted || !call.result ? undefined : definitions.get(call.name),
          tui,
          entry.data.cwd,
        );
        if (call.result) component.updateResult(call.result);
        else
          component.updateResult({
            content: [{ type: "text", text: "Result unavailable; history is incomplete." }],
            isError: true,
          });
        panel.addChild(new Spacer(1));
        panel.addChild(component);
      }
      if (!entry.data.complete)
        panel.addChild(
          new Text(
            theme.fg(
              "warning",
              "Incomplete nested IDE presentation; some results were not retained.",
            ),
            0,
            0,
          ),
        );
      components.set(entry.data, panel);
    }
    const warning = panel.children.at(-1);
    if (!entry.data.complete && warning instanceof Text)
      warning.setText(
        theme.fg("warning", "Incomplete nested IDE presentation; some results were not retained."),
      );
    for (const child of panel.children)
      if (child instanceof ToolExecutionComponent) child.setExpanded(options.expanded);
    return panel;
  });
  const finalize = () => {
    pi.events.on(NATIVE_EDIT_BATCH_EVENT, (value) => {
      const batch = value as NativeEditBatchEvent;
      const group = groups.get(batch.parentToolCallId);
      if (!group) return;
      const details = compactMutationDetails(batch.result.details);
      const lastChangedCall = batch.calls.findLast((id) => !batch.unchangedCopyCalls?.includes(id));
      const callIdsByResult: readonly unknown[] =
        "callIdsByResult" in details && Array.isArray(details.callIdsByResult)
          ? details.callIdsByResult
          : [];
      for (const id of batch.calls) {
        const call = group.calls.find((call) => call.id === id);
        if (!call) continue;
        const postWriteResults =
          details.results?.filter(
            (result, index) =>
              (callIdsByResult[index] === id ||
                (callIdsByResult.length === 0 && batch.calls.length === 1)) &&
              result.data.errors?.some(
                (error) => error.code === "POST_WRITE_FAILED" || error.code === "POST_EDIT_FAILED",
              ),
          ) ?? [];
        call.postWriteFailure = postWriteResults.length > 0;
        if (call.postWriteFailure) {
          call.batched = false;
          delete call.renderArgs;
          retainResult(group, call, {
            content: batch.result.content,
            details: { results: postWriteResults, effect: "applied" },
            isError: true,
          });
          continue;
        }
        const copyResult = batch.copyResults?.get(id);
        const rollback = copyResult?.details.metadata?.copyRollback;
        if (
          call.name === "copy" &&
          copyResult &&
          (rollback === "restored" || rollback === "failed")
        ) {
          call.copyRollback = rollback;
          call.batched = false;
          retainResult(group, call, {
            content: copyResult.content,
            details: compactMutationDetails(copyResult.details),
            isError: true,
          });
          continue;
        }
        // Keep no-op Copy outcomes; changed peers share the final batch diff.
        call.unchangedCopy =
          call.name === "copy" && batch.unchangedCopyCalls?.includes(id) === true;
        call.batched = !call.unchangedCopy && id !== lastChangedCall;
        if (call.unchangedCopy) {
          retainResult(group, call, {
            content: [{ type: "text", text: "No changes: destination already has this text." }],
            details: {},
            isError: false,
          });
        } else if (call.batched) call.result = undefined;
        else {
          // A multi-file batch has no single source: let the existing renderer label each file.
          if (new Set(details.mutationRender?.map((resource) => resource.path)).size > 1)
            call.renderArgs = {};
          call.rollback =
            details.results?.some((result) => result.data.rollback !== undefined) === true;
          retainResult(group, call, {
            content: batch.result.content,
            details,
            isError: batch.result.isError === true || call.rollback,
          });
        }
      }
    });
    pi.on("tool_result", (event) => {
      const details = event.details;
      const group = groups.get(event.toolCallId);
      if (
        group &&
        details &&
        typeof details === "object" &&
        "editorBatchResults" in details &&
        Array.isArray(details.editorBatchResults)
      ) {
        for (const report of details.editorBatchResults as BatchReport[]) {
          for (const operation of report.data?.operations ?? []) {
            const call = group.calls.find((call) => call.id === operation.id);
            if (!call) continue;
            const errors = operation.errors.map((error) => error.message);
            // Keep precise failure effects and their custom error panels.
            if (call.rollback || call.postWriteFailure || call.copyRollback !== undefined) continue;
            if (call.unchangedCopy && errors.length === 0 && operation.effect === "not-applied")
              continue;
            if (errors.length > 0 || operation.effect !== "applied") {
              call.batched = false;
              delete call.renderArgs;
              retainResult(group, call, {
                content: [
                  {
                    type: "text",
                    text: `${call.name}: ${operation.effect}.\n${errors.join("\n")}`,
                  },
                ],
                details: undefined,
                isError: errors.length > 0 || operation.effect === "unknown",
              });
            }
          }
        }
      }
    });
  };
  const registerTool: ExtensionAPI["registerTool"] = (definition) => {
    definitions.set(definition.name, definition as ToolDefinition);
    pi.registerTool(definition);
  };
  return { api: { ...pi, registerTool }, finalize };
}
