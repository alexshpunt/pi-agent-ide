import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { requiredValue } from "pi-agent-invariant";
import type { FileMutationBatchResult } from "#src/api/mutation-result.ts";
import type { TextMutationEdit } from "#src/api/mutation-tool.ts";
import { FileMutationResult } from "./mutation-result/file-mutation-result.ts";
import type { TextChange } from "./text-change-engine.ts";

/** Result text of an edit whose every target already had the requested text. */
export const ALREADY_DONE_TEXT = "No changes: every target already has this text.";

/** Positions listed in one result; the rest are counted. */
const LISTED_POSITIONS = 50;

/** A target that already had the requested text, at its 1-based position after the edit. */
export interface AlreadyDoneTarget {
  readonly lineNumber: number;
  readonly column: number;
}

/** A change whose range already holds its text: the target already has the requested result. */
export function isAlreadyDone(before: string, change: TextChange): boolean {
  return before.slice(change.from, change.to) === change.insert;
}

/** Positions of already-done changes in the text after all changes of the edit are applied. */
export function alreadyDoneTargets(
  before: string,
  changes: readonly TextChange[],
): readonly AlreadyDoneTarget[] {
  const ordered = [...changes].sort((left, right) => left.from - right.from);
  const offsets: number[] = [];
  let shift = 0;
  for (const change of ordered) {
    if (isAlreadyDone(before, change)) offsets.push(change.from + shift);
    shift += change.insert.length - (change.to - change.from);
  }
  if (offsets.length === 0) return [];
  const targets: AlreadyDoneTarget[] = [];
  let lineNumber = 1;
  let lineStart = 0;
  let scanned = 0;
  const after = applyOrdered(before, ordered);
  for (const offset of offsets) {
    for (; scanned < offset; scanned++) {
      if (after[scanned] === "\n") {
        lineNumber++;
        lineStart = scanned + 1;
      }
    }
    targets.push({ lineNumber, column: offset - lineStart + 1 });
  }
  return targets;
}

/** One line naming the targets that already had the requested text. */
export function describeAlreadyDone(targets: readonly AlreadyDoneTarget[]): string | undefined {
  if (targets.length === 0) return undefined;
  const listed = targets
    .slice(0, LISTED_POSITIONS)
    .map((target) => `${target.lineNumber}:${target.column}`);
  const more = targets.length - listed.length;
  return `Already had this text, left as is: ${targets.length} target${targets.length === 1 ? "" : "s"} at line:column ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

/** Success without a write: every target of the calls already had the requested text. */
export function alreadyDoneToolResult(
  mutations: readonly { readonly edits: ReadonlyMap<string, Pick<TextMutationEdit, "changes">> }[],
  snapshots: ReadonlyMap<string, string>,
): AgentToolResult<FileMutationBatchResult> {
  const changes = new Map<string, TextChange[]>();
  for (const mutation of mutations)
    for (const [source, edit] of mutation.edits)
      changes.set(source, [...(changes.get(source) ?? []), ...edit.changes]);
  const results = [...changes].flatMap(([source, sourceChanges]) => {
    const result = alreadyDoneFileResult(
      source,
      requiredValue(snapshots.get(source)),
      sourceChanges,
    );
    return result === undefined ? [] : [result];
  });
  return {
    content: [
      {
        type: "text",
        text: [ALREADY_DONE_TEXT, ...results.map(describeAlreadyDoneFile)].join("\n"),
      },
    ],
    details: { effect: "not-applied", results },
  };
}

/** Result of a source that was not written because every change of it was already done. */
export function alreadyDoneFileResult(
  source: string,
  content: string,
  changes: readonly TextChange[],
): FileMutationResult | undefined {
  if (changes.length === 0 || !changes.every((change) => isAlreadyDone(content, change)))
    return undefined;
  return new FileMutationResult({
    ok: true,
    path: source,
    afterContent: content,
    rawChanges: [],
    alreadyDone: alreadyDoneTargets(content, changes),
  });
}

/** One line naming a source and its targets that already had the requested text. */
export function describeAlreadyDoneFile(result: FileMutationResult): string {
  return `${result.path ?? ""}: ${describeAlreadyDone(result.data.alreadyDone ?? []) ?? ""}`;
}

function applyOrdered(before: string, ordered: readonly TextChange[]): string {
  let result = "";
  let position = 0;
  for (const change of ordered) {
    result += before.slice(position, change.from) + change.insert;
    position = change.to;
  }
  return result + before.slice(position);
}
