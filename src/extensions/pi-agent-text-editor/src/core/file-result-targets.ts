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
  reader?: (source: string, cwd: string, signal?: AbortSignal) => Promise<ResultSourceTarget>,
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
    const file = source.startsWith("ssh://") ? source : path.resolve(cwd, source);
    try {
      signal?.throwIfAborted();
      if (file.startsWith("ssh://")) {
        if (reader === undefined)
          throw new Error("Remote destination requires its guarded Read owner.");
        const fresh = await reader(file, cwd, signal);
        const lines = fresh.expectedContent.split(/\r\n|\r|\n/u);
        targets.push({
          ...fresh,
          ranges: [
            {
              start: { lineNumber: 1, column: 0 },
              end: { lineNumber: lines.length, column: lines.at(-1)?.length ?? 0 },
            },
          ],
        });
        states.push({ source: fresh.source, state: "present" });
        continue;
      }
      const stat = await lstat(file);
      states.push({ source: file, state: "present" });
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Restored target is not a regular text file.");
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
