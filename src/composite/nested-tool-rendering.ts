import {
  ToolExecutionComponent,
  type ExtensionAPI,
  type ToolDefinition,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  NATIVE_EDIT_BATCH_EVENT,
  type NativeEditBatchEvent,
} from "#src/extensions/pi-agent-text-editor/src/api/native-edit-batch-event.js";
import { compactMutationDetails } from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/src/persisted-result.js";
import type { FileMutationBatchResult } from "pi-agent-text-editor/api/mutation-result";
import { registerIdeAliasCompatibility } from "./ide-alias-rendering.js";

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
  argumentsTruncated?: boolean;
  resultOmitted?: boolean;
  // Older sessions only recorded whether a result display was omitted.
  omitted?: boolean;
  batched?: boolean;
  rollback?: boolean;
  postWriteFailure?: boolean;
  unchangedCopy?: boolean;
  copyRollback?: "restored" | "failed";
  /** The call's host-recorded execution time; absent in older history or when it did not run. */
  durationMs?: number;
  /** This call's panel shows the combined diff of several calls, so no single time applies. */
  groupedResult?: boolean;
  result?: { content: AgentToolResult<unknown>["content"]; details: unknown; isError: boolean };
}
interface BatchReport {
  data?: { operations?: { id: string; effect: string; errors: { message: string }[] }[] };
}
interface PanelGroup {
  parentToolCallId: string;
  parentToolName?: string;
  cwd: string;
  calls: ChildPanel[];
  retention: RetentionReasons;
}

interface RetentionReasons {
  argumentsTruncated: boolean;
  resultsOmitted: boolean;
  callsOmitted: boolean;
  resultsUnavailable: boolean;
}

const retained = (): RetentionReasons => ({
  argumentsTruncated: false,
  resultsOmitted: false,
  callsOmitted: false,
  resultsUnavailable: false,
});

interface SavedPanelGroup extends Omit<PanelGroup, "retention"> {
  retention?: RetentionReasons;
  // Older history did not record why it was incomplete.
  complete?: boolean;
}

function retentionWarning(group: SavedPanelGroup): string | undefined {
  const reasons = group.retention;
  const omissions = [
    reasons?.argumentsTruncated && "arguments shortened",
    reasons?.resultsOmitted && "result displays omitted",
    reasons?.callsOmitted && "call panels omitted",
    reasons?.resultsUnavailable && "results unavailable",
  ].filter(Boolean);
  if (omissions.length > 0)
    return `Nested IDE display: ${omissions.join("; ")}. Tool execution and parent output are unchanged.`;
  if (!reasons && group.complete === false)
    return "Nested IDE display is incomplete; omission details are unavailable.";
  return undefined;
}

/** Format a duration like native tool rows: `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${totalSeconds % 60}s`;
}

/** Keep bounded display data for nested IDE tools, separate from model context and usage. */
export function createNestedIdeRendering(pi: ExtensionAPI, hideCodemodeToolResults = false) {
  const definitions = new Map<string, ToolDefinition>();
  const aliasSource = registerIdeAliasCompatibility(pi, definitions);
  const aliasRoots = new Map<string, string>();
  const parents = new Map<string, string>();
  const groups = new Map<string, PanelGroup>();
  let tui: TUI | undefined;
  const components = new WeakMap<object, Container>();
  const timedDefinitions = new WeakMap<ToolDefinition, ToolDefinition>();
  /** Wrap a tool's result renderer so a final nested panel ends with its recorded time. */
  const timedDefinition = (name: string): ToolDefinition | undefined => {
    const definition = definitions.get(name);
    const renderResult = definition?.renderResult;
    if (!definition || !renderResult) return definition;
    let timed = timedDefinitions.get(definition);
    if (!timed) {
      const inner = new WeakMap<object, Component>();
      timed = {
        ...definition,
        renderResult(result, options, theme, context) {
          // Give the tool its own previous component, not the timing wrapper around it.
          const previous = context.lastComponent && inner.get(context.lastComponent);
          const rendered = renderResult.call(definition, result, options, theme, {
            ...context,
            lastComponent: previous ?? context.lastComponent,
          });
          if (options.isPartial || context.durationMs === undefined) return rendered;
          const container = new Container();
          container.addChild(rendered);
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("muted", `Took ${formatToolDuration(context.durationMs)}`), 0, 0),
          );
          inner.set(container, rendered);
          return container;
        },
      };
      timedDefinitions.set(definition, timed);
    }
    return timed;
  };
  const retainResult = (
    group: PanelGroup,
    call: ChildPanel,
    result: NonNullable<ChildPanel["result"]>,
  ) => {
    // Bound in-memory display data as each call finishes, not only at persistence.
    call.result = result;
    call.resultOmitted = false;
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
    call.resultOmitted = true;
  };
  const clear = () => {
    aliasRoots.clear();
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
    if (event.parentToolCallId === undefined) {
      const source = aliasSource(event.toolName);
      if (source !== undefined) aliasRoots.set(event.toolCallId, source);
      return;
    }
    const root = parents.get(event.parentToolCallId) ?? event.parentToolCallId;
    parents.set(event.toolCallId, root);
    // A direct alias already draws the native panel; its forwarding child must not duplicate it.
    if (aliasRoots.get(root) === event.toolName) return;
    if (!definitions.has(event.toolName)) return;
    let group = groups.get(root);
    if (!group) {
      group = { parentToolCallId: root, cwd: context.cwd, calls: [], retention: retained() };
      groups.set(root, group);
    }
    if (group.calls.length >= MAX_CALLS) {
      group.retention.callsOmitted = true;
      return;
    }
    const json = JSON.stringify(event.args);
    const remaining =
      MAX_ARGUMENT_TOTAL_BYTES -
      group.calls.reduce((bytes, call) => bytes + Buffer.byteLength(JSON.stringify(call.args)), 0) -
      // Reserve an empty object for every remaining call, even after argument space runs out.
      (MAX_CALLS - group.calls.length - 1) * 2;
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
    const boundedArgs =
      Buffer.byteLength(JSON.stringify(args)) <= Math.min(MAX_ARGUMENT_BYTES, remaining)
        ? args
        : {};
    group.calls.push({
      id: event.toolCallId,
      name: event.toolName,
      args: boundedArgs,
      argumentsTruncated: omitted,
    });
  });
  pi.on("tool_execution_end", (event) => {
    aliasRoots.delete(event.toolCallId);
    const root = parents.get(event.toolCallId);
    if (root === undefined) return;
    parents.delete(event.toolCallId);
    const group = groups.get(root);
    const call = group?.calls.find((call) => call.id === event.toolCallId);
    if (group && call) {
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs))
        call.durationMs = event.durationMs;
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
    const calls = group.calls.filter((call) => !call.batched);
    const saved: PanelGroup = {
      ...group,
      parentToolName: event.message.toolName,
      calls: [],
      retention: {
        ...group.retention,
        argumentsTruncated: calls.some((call) => call.argumentsTruncated === true),
        resultsOmitted: calls.some((call) => call.resultOmitted === true),
        resultsUnavailable: calls.some((call) => !call.result),
      },
    };
    // Include group metadata and separators, not just call payloads, in the history budget.
    let bytes = Buffer.byteLength(JSON.stringify(saved));
    for (const call of calls) {
      const json = JSON.stringify(call);
      bytes += Buffer.byteLength(json) + (saved.calls.length > 0 ? 1 : 0);
      if (bytes > MAX_BYTES) {
        saved.retention.callsOmitted = true;
        break;
      }
      saved.calls.push(JSON.parse(json) as ChildPanel);
    }
    pi.appendEntry(ENTRY_TYPE, saved);
  });
  pi.registerEntryRenderer<SavedPanelGroup>(
    ENTRY_TYPE,
    function renderEntry(entry, options, theme) {
      if (!Array.isArray(entry.data?.calls)) return undefined;
      const compact =
        hideCodemodeToolResults && entry.data.parentToolName === "codemode" && !options.expanded;
      const calls = compact
        ? entry.data.calls.filter((call) => call.result?.isError)
        : entry.data.calls;
      if (compact && calls.length === 0) {
        const warning = retentionWarning(entry.data);
        return warning ? new Text(theme.fg("warning", warning), 0, 0) : new Container();
      }
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
      const warningText = retentionWarning(entry.data);
      let panel = compact ? undefined : components.get(entry.data);
      if (!panel) {
        panel = new Container();
        for (const call of calls) {
          const component = new ToolExecutionComponent(
            call.name,
            call.id,
            call.renderArgs ?? call.args,
            { showImages: true },
            call.resultOmitted || call.omitted || !call.result
              ? undefined
              : timedDefinition(call.name),
            tui,
            entry.data.cwd,
          );
          if (call.result)
            component.updateResult({
              ...call.result,
              ...(call.durationMs === undefined || call.groupedResult === true
                ? {}
                : { durationMs: call.durationMs }),
            });
          else
            component.updateResult({
              content: [{ type: "text", text: "Result unavailable in this saved display." }],
              isError: true,
            });
          panel.addChild(new Spacer(1));
          panel.addChild(component);
        }
        if (warningText) panel.addChild(new Text(theme.fg("warning", warningText), 0, 0));
        if (!compact) components.set(entry.data, panel);
      }
      const warning = panel.children.at(-1);
      if (warningText && warning instanceof Text) warning.setText(theme.fg("warning", warningText));
      for (const child of panel.children)
        if (child instanceof ToolExecutionComponent) child.setExpanded(options.expanded);
      return panel;
    },
  );
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
        const copyResult = batch.mutationResults?.get(id);
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
        call.groupedResult =
          !call.batched &&
          !call.unchangedCopy &&
          batch.calls.filter((other) => !batch.unchangedCopyCalls?.includes(other)).length > 1;
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
          const targetUnavailable = (call.result?.details as FileMutationBatchResult | undefined)
            ?.metadata?.targetUnavailable;
          retainResult(group, call, {
            content: batch.result.content,
            details:
              typeof targetUnavailable === "string"
                ? {
                    ...details,
                    metadata: { ...details.metadata, targetUnavailable },
                  }
                : details,
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
