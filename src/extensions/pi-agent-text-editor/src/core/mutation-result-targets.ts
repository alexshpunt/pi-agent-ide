import type { ResultRange, ResultSourceTarget } from "pi-agent-resource";
import type { ResultTargetStore } from "pi-agent-resource";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "#src/api/mutation-result.js";
import { createTextDocument } from "pi-agent-text";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import type { TextMutationEdit } from "#src/api/mutation-tool.js";
import { applyTextChanges } from "./text-change-engine.js";
import type { TextEditorCore } from "./text-editor-core.js";

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
    if (
      !completion ||
      (completion.resolvedBy !== "filesystem" && !completion.resourceSource.startsWith("ssh://"))
    )
      continue;
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

/** Trusted Read pipeline callback, including full owning-source guards and snapshots. */
export type MutationSnapshotReader = (
  source: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ResultSourceTarget>;
const readers = new WeakMap<TextEditorCore, MutationSnapshotReader>();

/** Keep mutation output authority on the same guarded Read owner as ordinary inputs. */
export function setMutationSnapshotReader(
  core: TextEditorCore,
  reader: MutationSnapshotReader,
): void {
  readers.set(core, reader);
}

/** Recheck mapped text through the owning provider before registering any output authority. */
export async function verifyMutationTargets(
  core: TextEditorCore,
  targets: readonly ResultSourceTarget[],
  store: ResultTargetStore,
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly ResultSourceTarget[]> {
  const reader = readers.get(core);
  const verified: ResultSourceTarget[] = [];
  for (const target of targets) {
    signal?.throwIfAborted();
    if (reader === undefined) {
      verified.push(target);
      continue;
    }
    const fresh = await reader(target.source, cwd, signal);
    if (fresh.source !== target.source || fresh.expectedContent !== target.expectedContent)
      throw Error("Mutation target changed before publication; repeat Read/Search.");
    verified.push({ ...fresh, ranges: target.ranges });
  }
  await store.verify({ targets: verified, complete: true }, signal);
  return verified;
}

/** Publish only a successful call's actual written text; refusals and Delete never grant authority. */
export async function attachCommittedMutationTarget(
  result: AgentToolResult<FileMutationBatchResult>,
  completions: readonly TextEditCompletion[],
  core: TextEditorCore,
  store: ResultTargetStore,
  callId: string,
  cwd: string,
  operation: string,
  plannedEdits?: ReadonlyMap<string, TextMutationEdit>,
  signal?: AbortSignal,
): Promise<AgentToolResult<FileMutationBatchResult>> {
  if (
    operation === "delete" ||
    result.isError ||
    result.details.metadata?.resultTarget !== undefined
  )
    return result;
  if (
    result.details.results?.some((item) => !item.data.ok) ||
    result.details.effect === "not-applied"
  )
    return result;
  try {
    let targets: readonly ResultSourceTarget[];
    const semantic: unknown = result.details.metadata?.semanticAction;
    if (
      operation === "undo" &&
      semantic !== null &&
      typeof semantic === "object" &&
      "kind" in semantic &&
      semantic.kind === "apply-undo"
    ) {
      if (
        !("ok" in semantic) ||
        semantic.ok !== true ||
        !("restoredStates" in semantic) ||
        !Array.isArray(semantic.restoredStates)
      )
        throw Error("Restore did not report confirmed source states.");
      const reader = readers.get(core);
      if (reader === undefined)
        throw Error("Restored targets require their guarded Read provider.");
      targets = [];
      const states: readonly unknown[] = semantic.restoredStates;
      for (const state of states) {
        if (
          state === null ||
          typeof state !== "object" ||
          !("source" in state) ||
          typeof state.source !== "string" ||
          !("state" in state)
        )
          throw Error("Restore returned an invalid source state.");
        if (state.state === "absent") continue;
        if (state.state !== "present") throw Error("Restore source state is unknown.");
        const fresh = await reader(state.source, cwd, signal);
        const lines = fresh.expectedContent.split(/\r\n|\r|\n/u);
        targets = [
          ...targets,
          {
            ...fresh,
            ranges: [
              {
                start: { lineNumber: 1, column: 0 },
                end: { lineNumber: lines.length, column: lines.at(-1)?.length ?? 0 },
              },
            ],
          },
        ];
      }
    } else if (
      semantic !== null &&
      typeof semantic === "object" &&
      "kind" in semantic &&
      semantic.kind === "file-operation"
    ) {
      if (
        !("ok" in semantic) ||
        semantic.ok !== true ||
        !("target" in semantic) ||
        typeof semantic.target !== "string"
      )
        return result;
      if ("postProcessingError" in semantic)
        throw Error("Post-processing did not complete; inspect the saved file.");
      const reader = readers.get(core);
      if (reader === undefined)
        throw Error("Whole-file target requires its guarded Read provider.");
      const fresh = await reader(semantic.target, cwd, signal);
      const lines = fresh.expectedContent.split(/\r\n|\r|\n/u);
      const last = lines.at(-1);
      targets = [
        {
          ...fresh,
          ranges: [
            {
              start: { lineNumber: 1, column: 0 },
              end: { lineNumber: lines.length, column: last?.length ?? 0 },
            },
          ],
        },
      ];
    } else {
      const edits = new Map<string, TextMutationEdit>();
      for (const item of result.details.results ?? []) {
        if (!item.data.path || !item.data.rawChanges) continue;
        const planned = plannedEdits?.get(item.data.path);
        if ((operation === "copy" || operation === "move") && planned === undefined)
          throw Error("Transfer handler did not report destination change ownership.");
        edits.set(
          item.data.path,
          planned ?? {
            action: "edited",
            changes: item.data.rawChanges.map((change) => ({
              from: change.fromA,
              to: change.toA,
              insert: change.insertedText,
            })),
          },
        );
      }
      if (operation === "write" || operation === "undo") {
        targets = [...new Map(completions.map((item) => [item.resourceSource, item])).values()]
          .filter((item) => edits.has(item.source) || edits.has(item.resourceSource))
          .map((item) => {
            const lines = item.after.content.split(/\r\n|\r|\n/u);
            return {
              source: item.resourceSource,
              expectedContent: item.after.content,
              ranges: [
                {
                  start: { lineNumber: 1, column: 0 },
                  end: { lineNumber: lines.length, column: lines.at(-1)?.length ?? 0 },
                },
              ],
            };
          });
      } else {
        targets = committedMutationTargets([{ callId, edits }], completions).get(callId) ?? [];
      }
      if (edits.size > 0 && targets.length === 0)
        throw Error("This operation did not produce confirmed text targets.");
      if (edits.size === 0 && result.details.metadata?.emptyTargets !== true) return result;
    }
    if (targets.length === 0) return result;
    const verified = await verifyMutationTargets(core, targets, store, cwd, signal);
    return {
      ...result,
      details: {
        ...result.details,
        metadata: { ...result.details.metadata, resultTarget: store.register(verified, cwd) },
      },
    };
  } catch (error) {
    // Output verification cannot erase an already observed publication or imply a rollback.
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
