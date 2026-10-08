import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResultRange, ResultSourceTarget } from "pi-agent-resource";
import type { ResultTargetStore } from "pi-agent-resource";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "#src/api/mutation-result.js";
import { createTextDocument } from "pi-agent-text";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import type { TextMutation, TextMutationEdit } from "#src/api/mutation-tool.js";
import { applyTextChanges } from "./text-change-engine.js";
import { attachFileMutationTargets } from "./file-result-targets.js";

import type { TextEditorCore } from "./text-editor-core.js";

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
    const source = target.source.includes("://")
      ? target.source
      : cwd.startsWith("ssh://")
        ? new URL(target.source, cwd.endsWith("/") ? cwd : cwd + "/").href
        : path.resolve(cwd, target.source);
    const fresh = await reader(source, cwd, signal);
    if (fresh.source !== source || fresh.expectedContent !== target.expectedContent)
      throw Error("Mutation target changed before publication; repeat Read/Search.");
    verified.push({ ...fresh, ranges: target.ranges });
  }
  await store.verify({ targets: verified, complete: true }, signal);
  return verified;
}

/** A call's changes retain ownership even when several calls commit together. */
export interface OwnedMutationChanges {
  readonly callId: string;
  readonly edits: ReadonlyMap<string, TextMutationEdit>;
}

/** Find Copy destinations with identical text and no secondary resource action. */
export function unchangedCopySources(
  mutation: TextMutation,
  snapshots: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  if (mutation.afterWrite !== undefined || mutation.semanticAction !== undefined) return new Set();
  return new Set(
    [...mutation.edits]
      .filter(([source, edit]) => {
        const before = snapshots.get(source);
        return (
          before !== undefined &&
          edit.changes.length > 0 &&
          edit.changes.every(
            (change) =>
              change.allowUnchanged && before.slice(change.from, change.to) === change.insert,
          )
        );
      })
      .map(([source]) => source),
  );
}
/** Map final resource snapshots and unchanged Copy ranges; verify before publishing. */
export function committedMutationTargets(
  mutations: readonly OwnedMutationChanges[],
  completions: readonly Pick<
    TextEditCompletion,
    "source" | "resourceSource" | "resolvedBy" | "before" | "after" | "existed"
  >[],
  unchangedSnapshots: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, readonly ResultSourceTarget[]> {
  const targets = new Map<string, ResultSourceTarget[]>();
  const sources = new Set(mutations.flatMap((mutation) => [...mutation.edits.keys()]));
  for (const source of sources) {
    const completion = completions.findLast(
      (item) => item.source === source || item.resourceSource === source,
    );
    if (
      completion &&
      completion.resolvedBy !== "filesystem" &&
      !completion.resourceSource.startsWith("ssh://")
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
    const before = completion?.before.content ?? unchangedSnapshots.get(source);
    if (before === undefined) continue;
    if (
      !completion &&
      changes.some(
        (change) =>
          !change.allowUnchanged || before.slice(change.from, change.to) !== change.insert,
      )
    )
      continue;
    const after = completion?.after.content ?? before;
    const resourceSource = completion?.resourceSource ?? source;
    if (applyTextChanges(before, changes, completion?.existed === false).content !== after)
      throw new Error("Mutation targets cannot be mapped to the actual written snapshot.");
    const starts = [0];
    for (const line of createTextDocument(resourceSource, after).lines)
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
        source: resourceSource,
        expectedContent: after,
        ranges: selected,
      });
      targets.set(callId, own);
    }
  }
  return targets;
}

/** Explain missing Copy authority without changing its write outcome. */
export function describeUnavailableCopyTarget(
  result: AgentToolResult<FileMutationBatchResult>,
): AgentToolResult<FileMutationBatchResult> {
  const notice = "No verified text selection. Read the destination before further edits.";
  if (
    result.isError ||
    typeof result.details.metadata?.targetUnavailable !== "string" ||
    result.content.some((block) => block.type === "text" && block.text === notice)
  )
    return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: notice,
      },
    ],
  };
}

/** Publish a successful file Write's verified whole-file snapshot, never an input action. */
export async function attachWriteTarget(
  result: AgentToolResult<FileMutationBatchResult>,
  core: TextEditorCore,
  store: ResultTargetStore,
  cwd: string,
  signal?: AbortSignal,
  completions: readonly Pick<TextEditCompletion, "source" | "resourceSource" | "resolvedBy">[] = [],
): Promise<AgentToolResult<FileMutationBatchResult>> {
  if (result.isError) return result;
  const file = result.details.results?.[0]?.data;
  if (file?.path === undefined || file.afterContent === undefined) return result;
  const completion = completions.findLast(
    (item) => item.source === file.path || item.resourceSource === file.path,
  );
  if (
    completion !== undefined &&
    completion.resolvedBy !== "filesystem" &&
    !completion.resourceSource.startsWith("ssh://")
  )
    return result;
  try {
    const content = file.afterContent;
    const lines = content.split(/\r\n|\r|\n/u);
    const targets: ResultSourceTarget[] = [
      {
        source: file.path.startsWith("ssh://")
          ? file.path
          : path.resolve(
              cwd,
              file.path.startsWith("file://") ? fileURLToPath(file.path) : file.path,
            ),
        expectedContent: content,
        ranges: [
          {
            start: { lineNumber: 1, column: 0 },
            end: { lineNumber: lines.length, column: lines.at(-1)?.length ?? 0 },
          },
        ],
      },
    ];
    const verified = await verifyMutationTargets(core, targets, store, cwd, signal);
    return {
      ...result,
      details: {
        ...result.details,
        metadata: { ...result.details.metadata, resultTarget: store.register(verified, cwd) },
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
/** Publish immediate results only when their committed range mapping is verified. */
export async function attachCommittedMutationTarget(
  result: AgentToolResult<FileMutationBatchResult>,
  completions: readonly TextEditCompletion[],
  core: TextEditorCore,
  store: ResultTargetStore,
  callId: string,
  cwd: string,
  signal?: AbortSignal,
  wholeFile = false,
  plannedEdits?: ReadonlyMap<string, TextMutationEdit>,
  destinationOnly = false,
  unchangedSnapshots: ReadonlyMap<string, string> = new Map(),
): Promise<AgentToolResult<FileMutationBatchResult>> {
  if (result.isError || typeof result.details.metadata?.resultTarget === "string") return result;
  result = await attachFileMutationTargets(result, store, cwd, signal, readers.get(core));
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
  for (const [source, edit] of plannedEdits ?? [])
    if (!edits.has(source) && unchangedSnapshots.has(source)) edits.set(source, edit);
  if (edits.size === 0 && result.details.metadata?.emptyTargets !== true) return result;
  try {
    const mapped = committedMutationTargets([{ callId, edits }], completions, unchangedSnapshots);
    const targets = mapped.get(callId) ?? [];
    const outputCount = [...edits.values()].filter(
      (edit) => edit.resultChanges?.length !== 0,
    ).length;
    if (outputCount > 0 && targets.length !== outputCount)
      throw new Error("This operation did not produce confirmed filesystem targets.");
    const verified = await verifyMutationTargets(core, targets, store, cwd, signal);
    return {
      ...result,
      details: {
        ...result.details,
        metadata: { ...result.details.metadata, resultTarget: store.register(verified, cwd) },
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
