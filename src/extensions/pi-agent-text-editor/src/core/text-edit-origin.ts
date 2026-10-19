import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextEditorCore } from "./text-editor-core.js";

const activeOrigin = new AsyncLocalStorage<string>();
const executionRoots = new WeakMap<TextEditorCore, Map<string, string>>();

/** Retain native execution ancestry, never infer ownership from paths or current activity. */
export function registerTextEditOrigins(pi: ExtensionAPI, core: TextEditorCore): void {
  const roots = new Map<string, string>();
  executionRoots.set(core, roots);
  pi.on("tool_call", (event) => {
    const parent = event.parentToolCallId;
    roots.set(
      event.toolCallId,
      parent === undefined ? event.toolCallId : (roots.get(parent) ?? parent),
    );
  });
  pi.on("tool_result", (event) => {
    roots.delete(event.toolCallId);
  });
  pi.on("agent_end", () => {
    roots.clear();
  });
  pi.on("session_shutdown", () => {
    roots.clear();
  });
}

/** Execute an edit or its delayed batch with the original visible tool-call identity. */
export function withTextEditOrigin<T>(core: TextEditorCore, toolCallId: string, work: () => T): T {
  return activeOrigin.run(executionRoots.get(core)?.get(toolCallId) ?? toolCallId, work);
}

/** Snapshot this identity before deferring final processing outside its originating call. */
export function currentTextEditOrigin(): string | undefined {
  return activeOrigin.getStore();
}
