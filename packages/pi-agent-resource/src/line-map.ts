import { diffArrays } from "diff";
import type { ResultRange } from "./result-targets.ts";

/**
 * Beyond this many added and removed lines a file counts as rewritten and nothing is carried over.
 * The comparison runs on the caller's thread and grows quadratically with this length: about
 * 0.15 s at 1000 lines and 0.5 s at 2000 on a 26,000-line file.
 */
const maxEditedLines = 1500;

/**
 * Where each line of one text sits in another text. Line numbers are one-based, as in ranges.
 * A line counts as unchanged only when its text and line ending are identical; a moved or edited
 * line has no counterpart.
 */
export interface LineMap {
  /** Line number in the new text for an old line, or `undefined` when that line changed or vanished. */
  readonly newLine: (oldLine: number) => number | undefined;
  /** The map as a table indexed by old line number; 0 marks a changed line. */
  readonly table: Int32Array;
  /** Lines of both texts with their line endings, zero-based; used to look inside changed lines. */
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

/** Split like the editors do (`\n` ends a line), keeping each line ending so endings compare too. */
function lineTokens(content: string): string[] | undefined {
  // A lone CR ends a line for some readers and not for others, so line numbers would be ambiguous.
  if (/\r(?!\n)/u.test(content)) return undefined;
  const lines = content.split("\n");
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

/** Compare two texts line by line. Returns `undefined` when they cannot be related safely. */
export function createLineMap(before: string, after: string): LineMap | undefined {
  const old = lineTokens(before);
  const next = lineTokens(after);
  if (old === undefined || next === undefined) return undefined;
  const table = new Int32Array(old.length + 1);
  let prefix = 0;
  const shortest = Math.min(old.length, next.length);
  while (prefix < shortest && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix += 1;
  for (let index = 0; index < prefix; index += 1) table[index + 1] = index + 1;
  for (let index = 0; index < suffix; index += 1)
    table[old.length - suffix + index + 1] = next.length - suffix + index + 1;
  const oldMiddle = old.slice(prefix, old.length - suffix);
  const newMiddle = next.slice(prefix, next.length - suffix);
  if (oldMiddle.length > 0 && newMiddle.length > 0) {
    const parts = diffArrays(oldMiddle, newMiddle, { maxEditLength: maxEditedLines });
    if (parts === undefined) return undefined;
    let oldIndex = 0;
    let newIndex = 0;
    for (const part of parts) {
      if (part.added) newIndex += part.count;
      else if (part.removed) oldIndex += part.count;
      else {
        const count = part.count;
        for (let offset = 0; offset < count; offset += 1)
          table[prefix + oldIndex + offset + 1] = prefix + newIndex + offset + 1;
        oldIndex += count;
        newIndex += count;
      }
    }
  }
  return {
    table,
    oldLines: old,
    newLines: next,
    newLine: (oldLine) => {
      const line = table[oldLine];
      return line === undefined || line === 0 ? undefined : line;
    },
  };
}

/**
 * Move a range to the new text. Every line it touches must be unchanged and still adjacent;
 * otherwise the selected text changed, and the range has no safe position.
 */
export function rebaseRange(range: ResultRange, map: LineMap): ResultRange | undefined {
  const { start, end } = range;
  // A range that ends at column 0 of a later line stops after the previous line's ending.
  const endsAfterLine = end.column === 0 && end.lineNumber > start.lineNumber;
  const lastLine = endsAfterLine ? end.lineNumber - 1 : end.lineNumber;
  let first: number | undefined;
  let previous: number | undefined;
  for (let line = start.lineNumber; line <= lastLine; line += 1) {
    const moved = map.newLine(line);
    if (moved === undefined || (previous !== undefined && moved !== previous + 1)) return undefined;
    first ??= moved;
    previous = moved;
  }
  if (first === undefined || previous === undefined) return undefined;
  return {
    ...range,
    start: { lineNumber: first, column: start.column },
    end: { lineNumber: endsAfterLine ? previous + 1 : previous, column: end.column },
  };
}

/**
 * Find the same region of the new text when some of the range's own lines changed. An edge line
 * that is unchanged keeps its exact position; a changed edge reaches out to the nearest unchanged
 * line beyond it, so the region covers whatever replaced the old text. At least one line inside
 * the range must be unchanged: without one, nothing tells the region from other text. The result
 * is marked `adjusted`: its text is not the text that was selected.
 *
 * `newLines` is the new text split at `\n`; the range may then end on a line that is not the last.
 */
export function relocateRange(
  range: ResultRange,
  map: LineMap,
  newLines: readonly string[],
): ResultRange | undefined {
  const { start, end } = range;
  const endsAfterLine = end.column === 0 && end.lineNumber > start.lineNumber;
  const lastLine = endsAfterLine ? end.lineNumber - 1 : end.lineNumber;
  let survives = false;
  for (let line = start.lineNumber; line <= lastLine && !survives; line += 1)
    survives = map.newLine(line) !== undefined;
  if (!survives) return undefined;

  const first = map.newLine(start.lineNumber);
  let from: ResultRange["start"];
  if (first !== undefined) from = { lineNumber: first, column: start.column };
  else {
    let previous = 0;
    for (let line = start.lineNumber - 1; line >= 1; line -= 1) {
      const moved = map.newLine(line);
      if (moved === undefined) continue;
      previous = moved;
      break;
    }
    from = { lineNumber: previous + 1, column: 0 };
  }

  const last = map.newLine(lastLine);
  let to: ResultRange["end"];
  if (last !== undefined) to = { lineNumber: endsAfterLine ? last + 1 : last, column: end.column };
  else {
    let next: number | undefined;
    for (let line = lastLine + 1; line < map.table.length && next === undefined; line += 1)
      next = map.newLine(line);
    to =
      next === undefined
        ? { lineNumber: newLines.length, column: newLines.at(-1)?.length ?? 0 }
        : { lineNumber: next, column: 0 };
  }
  return { ...range, start: from, end: to, adjusted: true };
}

/**
 * Move a range to the new text. Its text is kept exactly when it is unchanged, also when only
 * other parts of its line changed; otherwise the region that replaced it is found and marked
 * `adjusted`.
 */
export function moveRange(
  range: ResultRange,
  map: LineMap,
  newLines: () => readonly string[],
): ResultRange | undefined {
  return rebaseOrRelocateRange(range, map) ?? relocateRange(range, map, newLines());
}

/** A changed stretch larger than this is not searched for a moved match; it counts as ambiguous. */
const maxHunkLines = 200;

/** The changed stretch around an old line: its lines in both texts, one-based and inclusive. */
function hunkAround(
  map: LineMap,
  line: number,
):
  | {
      readonly oldFrom: number;
      readonly oldTo: number;
      readonly newFrom: number;
      readonly newTo: number;
    }
  | undefined {
  const count = map.oldLines.length;
  let before = line - 1;
  while (before >= 1 && map.newLine(before) === undefined) before -= 1;
  let after = line + 1;
  while (after <= count && map.newLine(after) === undefined) after += 1;
  if (after - before > maxHunkLines) return undefined;
  const newBefore = before < 1 ? 0 : (map.newLine(before) ?? 0);
  const newAfter = after > count ? map.newLines.length + 1 : (map.newLine(after) ?? 0);
  return { oldFrom: before + 1, oldTo: after - 1, newFrom: newBefore + 1, newTo: newAfter - 1 };
}

function lineText(lines: readonly string[], line: number): string {
  const token = lines[line - 1] ?? "";
  return token.endsWith("\n") ? token.slice(0, -1) : token;
}

/** Every start of `text` in the given lines, overlapping starts included, in reading order. */
function occurrences(
  lines: readonly string[],
  from: number,
  to: number,
  text: string,
): { line: number; column: number }[] {
  const found: { line: number; column: number }[] = [];
  for (let line = from; line <= to; line += 1) {
    const content = lineText(lines, line);
    for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + 1))
      found.push({ line, column: at });
  }
  return found;
}

/**
 * Move a one-line match whose line changed around it. The match keeps its identity only when the
 * changed stretch holds the same number of copies of the matched text, the same copy comes first
 * in the new stretch, and the characters on both sides of it are unchanged. Anything else is
 * ambiguous and has no safe position.
 */
export function relocateInChangedLine(range: ResultRange, map: LineMap): ResultRange | undefined {
  const { start, end } = range;
  if (range.linewise === true || start.lineNumber !== end.lineNumber || start.column >= end.column)
    return undefined;
  const hunk = hunkAround(map, start.lineNumber);
  if (hunk === undefined || hunk.newTo < hunk.newFrom) return undefined;
  const content = lineText(map.oldLines, start.lineNumber);
  const matched = content.slice(start.column, end.column);
  const old = occurrences(map.oldLines, hunk.oldFrom, hunk.oldTo, matched);
  const next = occurrences(map.newLines, hunk.newFrom, hunk.newTo, matched);
  const index = old.findIndex(
    (item) => item.line === start.lineNumber && item.column === start.column,
  );
  const moved = next[index];
  if (index === -1 || moved === undefined || old.length !== next.length) return undefined;
  const target = lineText(map.newLines, moved.line);
  if (
    content.slice(start.column - 1, start.column) !==
      target.slice(moved.column - 1, moved.column) ||
    content.slice(end.column, end.column + 1) !==
      target.slice(moved.column + matched.length, moved.column + matched.length + 1)
  )
    return undefined;
  return {
    ...range,
    start: { lineNumber: moved.line, column: moved.column },
    end: { lineNumber: moved.line, column: moved.column + matched.length },
  };
}

/** Rebase a range through unchanged lines, or through a changed line that leaves its text intact. */
export function rebaseOrRelocateRange(range: ResultRange, map: LineMap): ResultRange | undefined {
  return rebaseRange(range, map) ?? relocateInChangedLine(range, map);
}

/** Say where a range that could not be moved stands now, so the caller can pick a new target. */
export function describeLostRange(range: ResultRange, map: LineMap | undefined): string {
  const line = range.start.lineNumber;
  if (map === undefined) return `line ${String(line)}: the file changed too much to follow it`;
  const original = lineText(map.oldLines, line).trim();
  const hunk = hunkAround(map, line);
  const shown = (text: string) => (text.length > 120 ? `${text.slice(0, 120)}…` : text);
  const head = `line ${String(line)} \`${shown(original)}\``;
  if (hunk === undefined) return `${head}: changed or moved`;
  if (hunk.newTo < hunk.newFrom) return `${head}: deleted`;
  const now = [];
  for (let at = hunk.newFrom; at <= Math.min(hunk.newTo, hunk.newFrom + 2); at += 1)
    now.push(`${String(at)}| ${shown(lineText(map.newLines, at).trim())}`);
  return `${head}: now ${now.join(" / ")}${hunk.newTo - hunk.newFrom > 2 ? " …" : ""}`;
}
