import type { DebugSessionSnapshot } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

/** Extract one immutable snapshot from a debugger semantic-action receipt. */
export function debuggerSnapshotFromResult(details: unknown): DebugSessionSnapshot | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const metadata = (details as { readonly metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const semantic = (metadata as { readonly semanticAction?: unknown }).semanticAction;
  if (typeof semantic !== "object" || semantic === null) return undefined;
  const snapshot = (semantic as { readonly snapshot?: unknown }).snapshot;
  return typeof snapshot === "object" && snapshot !== null
    ? (snapshot as DebugSessionSnapshot)
    : undefined;
}
