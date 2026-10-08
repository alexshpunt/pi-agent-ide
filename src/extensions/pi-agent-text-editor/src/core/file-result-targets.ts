import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ResultSourceTarget, ResultTargetStore } from "pi-agent-resource";
import type { FileMutationBatchResult } from "#src/api/mutation-result.js";

/** Publish whole destination/restored files only after checking their actual text bytes. */
export async function attachFileMutationTargets(
  result: AgentToolResult<FileMutationBatchResult>,
  store: ResultTargetStore,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  const action = result.details.metadata?.semanticAction;
  if (action === null || typeof action !== "object") return result;
  const semantic = action as Record<string, unknown>;
  if (semantic.ok !== true || semantic.postProcessingError !== undefined) return result;
  const sources =
    semantic.kind === "file-operation" && typeof semantic.target === "string"
      ? [semantic.target]
      : undefined;
  if (sources === undefined) return result;
  const states: { source: string; state: "present" | "absent" }[] = [];
  const targets: ResultSourceTarget[] = [];
  let unavailable: string | undefined;
  for (const source of sources) {
    const file = path.resolve(cwd, source);
    try {
      signal?.throwIfAborted();
      const stat = await lstat(file);
      states.push({ source: file, state: "present" });
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Target is not a regular text file; no text selection is available.");
      const bytes = await readFile(file, { signal });
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes("\0")) throw new Error("Binary file has no supported text target.");
      const lines = content.split(/\r\n|\r|\n/u);
      targets.push({
        source: file,
        expectedContent: content,
        ranges: [
          {
            start: { lineNumber: 1, column: 0 },
            end: { lineNumber: lines.length, column: lines.at(-1)?.length ?? 0 },
          },
        ],
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
        states.push({ source: file, state: "absent" });
      else unavailable ??= error instanceof Error ? error.message : String(error);
    }
  }
  try {
    if (unavailable === undefined) await store.verify({ targets, complete: true }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    unavailable = error instanceof Error ? error.message : String(error);
  }
  return {
    ...result,
    details: {
      ...result.details,
      metadata: {
        ...result.details.metadata,
        resultFileStates: states,
        ...(unavailable !== undefined
          ? { targetUnavailable: unavailable }
          : targets.length > 0
            ? { resultTarget: store.register(targets, cwd) }
            : {}),
      },
    },
  };
}
