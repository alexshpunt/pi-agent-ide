import type { ResultRange, ResultSourceTarget } from "pi-agent-resource";
import type { ResultTargetStore } from "pi-agent-resource";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "#src/api/mutation-result.js";
import { createTextDocument } from "pi-agent-text";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import type { TextMutationEdit } from "#src/api/mutation-tool.js";
import { applyTextChanges } from "./text-change-engine.js";
import { attachFileMutationTargets } from "./file-result-targets.js";

/** A call's changes retain ownership even when several calls commit together. */
export interface OwnedMutationChanges {
  readonly callId: string;
  readonly edits: ReadonlyMap<string, TextMutationEdit>;
}

/** Map each call to its actual inserted text, including shifts from all batch peers. */
export function committedMutationTargets(
  mutations: readonly OwnedMutationChanges[],
  completions: readonly TextEditCompletion[],
): ReadonlyMap<string, readonly ResultSourceTarget[]> {
  const targets = new Map<string, ResultSourceTarget[]>();
  const sources = new Set(mutations.flatMap((mutation) => [...mutation.edits.keys()]));
  for (const source of sources) {
    const completion = completions.findLast(
      (item) => item.source === source || item.resourceSource === source,
    );
    if (!completion || completion.resolvedBy !== "filesystem") continue;
    const changes = mutations
      .flatMap((mutation) =>
        (mutation.edits.get(source)?.changes ?? []).map((change, index) => ({
          ...change,
          callId: mutation.callId,
          producesTarget: mutation.edits.get(source)?.resultChanges?.includes(index) ?? true,
        })),
      )
      .sort((left, right) => left.from - right.from);
    const before = completion.before.content;
    const after = completion.after.content;
    if (applyTextChanges(before, changes, !completion.existed).content !== after)
      throw new Error("Mutation targets cannot be mapped to the actual written snapshot.");
    const starts = [0];
    for (const line of createTextDocument(completion.resourceSource, after).lines)
      if (line.lineEnding.length > 0)
        starts.push((starts.at(-1) ?? 0) + line.content.length + line.lineEnding.length);
    const position = (offset: number): ResultRange["start"] => {
      let first = 0;
      let last = starts.length - 1;
      while (first < last) {
        const middle = Math.ceil((first + last) / 2);
        if ((starts[middle] ?? after.length) <= offset) first = middle;
        else last = middle - 1;
      }
      return { lineNumber: first + 1, column: offset - (starts[first] ?? 0) };
    };
    let shift = 0;
    const ranges = new Map<string, ResultRange[]>();
    for (const change of changes) {
      const start = change.from + shift;
      if (change.producesTarget) {
        const own = ranges.get(change.callId) ?? [];
        own.push({ start: position(start), end: position(start + change.insert.length) });
        ranges.set(change.callId, own);
      }
      shift += change.insert.length - (change.to - change.from);
    }
    for (const mutation of mutations) {
      if (mutation.edits.get(source)?.action === "overwritten")
        ranges.set(mutation.callId, [{ start: position(0), end: position(after.length) }]);
    }
    for (const [callId, selected] of ranges) {
      const own = targets.get(callId) ?? [];
      own.push({
        source: completion.resourceSource,
        expectedContent: after,
        ranges: selected,
      });
      targets.set(callId, own);
    }
  }
  return targets;
}

/** Publish immediate results only when their committed range mapping is verified. */
export async function attachCommittedMutationTarget(
  result: AgentToolResult<FileMutationBatchResult>,
  completions: readonly TextEditCompletion[],
  store: ResultTargetStore,
  callId: string,
  cwd: string,
  signal?: AbortSignal,
  wholeFile = false,
  plannedEdits?: ReadonlyMap<string, TextMutationEdit>,
  destinationOnly = false,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  if (result.isError || typeof result.details.metadata?.resultTarget === "string") return result;
  result = await attachFileMutationTargets(result, store, cwd, signal);
  if (
    typeof result.details.metadata?.resultTarget === "string" ||
    result.details.metadata?.targetUnavailable !== undefined
  )
    return result;
  if (
    destinationOnly &&
    result.details.results?.some((item) => !plannedEdits?.has(item.data.path ?? ""))
  )
    return {
      ...result,
      details: {
        ...result.details,
        metadata: {
          ...result.details.metadata,
          targetUnavailable: "Transfer handler did not report destination change ownership.",
        },
      },
    };
  const edits = new Map<string, TextMutationEdit>();
  for (const item of result.details.results ?? []) {
    if (!item.data.ok || !item.data.path || !item.data.rawChanges) return result;
    const planned = plannedEdits?.get(item.data.path);
    edits.set(
      item.data.path,
      planned !== undefined
        ? {
            ...planned,
            ...(wholeFile ? { action: "overwritten" as const } : {}),
          }
        : {
            action: wholeFile ? "overwritten" : "edited",
            changes: item.data.rawChanges.map((change) => ({
              from: change.fromA,
              to: change.toA,
              insert: change.insertedText,
            })),
          },
    );
  }
  if (edits.size === 0 && result.details.metadata?.emptyTargets !== true) return result;
  try {
    const mapped = committedMutationTargets([{ callId, edits }], completions);
    const targets = mapped.get(callId) ?? [];
    const outputCount = [...edits.values()].filter(
      (edit) => edit.resultChanges?.length !== 0,
    ).length;
    if (outputCount > 0 && targets.length !== outputCount)
      throw new Error("This operation did not produce confirmed filesystem targets.");
    await store.verify({ targets, complete: true }, signal);
    return {
      ...result,
      details: {
        ...result.details,
        metadata: { ...result.details.metadata, resultTarget: store.register(targets, cwd) },
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...result,
      details: {
        ...result.details,
        metadata: {
          ...result.details.metadata,
          targetUnavailable: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}
