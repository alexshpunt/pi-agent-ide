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
  return old === undefined || next === undefined ? undefined : orderedMap(old, next);
}

function orderedMap(old: readonly string[], next: readonly string[]): LineMap | undefined {
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

/** The final included line, excluding the next line's column-zero endpoint. */
export function lastSelectedLine({ start, end }: ResultRange): number {
  return end.column === 0 && end.lineNumber > start.lineNumber
    ? end.lineNumber - 1
    : end.lineNumber;
}

/**
 * Move a range to the new text. Every line it touches must be unchanged and still adjacent;
 * otherwise the selected text changed, and the range has no safe position.
 */
export function rebaseRange(
  range: ResultRange,
  map: Pick<LineMap, "newLine">,
): ResultRange | undefined {
  const { start, end } = range;
  const lastLine = lastSelectedLine(range);
  const endsAfterLine = lastLine !== end.lineNumber;
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
  const lastLine = lastSelectedLine(range);
  const endsAfterLine = lastLine !== end.lineNumber;
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

interface LineHunk {
  readonly oldFrom: number;
  readonly oldTo: number;
  readonly newFrom: number;
  readonly newTo: number;
}

/** The changed stretch around an old line: its lines in both texts, one-based and inclusive. */
function hunkAround(map: LineMap, line: number): LineHunk | undefined {
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

function withoutEnding(token: string): string {
  return token.replace(/\r?\n$/u, "");
}

function lineText(lines: readonly string[], line: number): string {
  return withoutEnding(lines[line - 1] ?? "");
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
  return relocateInHunk(range, map.oldLines, map.newLines, () =>
    hunkAround(map, range.start.lineNumber),
  );
}

function relocateInHunk(
  range: ResultRange,
  oldLines: readonly string[],
  newLines: readonly string[],
  locate: () => LineHunk | undefined,
  requireUnique = false,
): ResultRange | undefined {
  const { start, end } = range;
  if (range.linewise === true || start.lineNumber !== end.lineNumber || start.column >= end.column)
    return undefined;
  const hunk = locate();
  if (hunk === undefined || hunk.newTo < hunk.newFrom) return undefined;
  const content = lineText(oldLines, start.lineNumber);
  const matched = content.slice(start.column, end.column);
  if (matched.length !== end.column - start.column) return undefined;
  const old = occurrences(oldLines, hunk.oldFrom, hunk.oldTo, matched);
  const next = occurrences(newLines, hunk.newFrom, hunk.newTo, matched);
  const index = old.findIndex(
    (item) => item.line === start.lineNumber && item.column === start.column,
  );
  const moved = next[index];
  if (
    index === -1 ||
    moved === undefined ||
    old.length !== next.length ||
    (requireUnique && old.length !== 1)
  )
    return undefined;
  const target = lineText(newLines, moved.line);
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

/** One-based positions; a zero entry means the token occurs more than once. */
function uniqueLines(lines: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (const [index, line] of lines.entries())
    positions.set(line, positions.has(line) ? 0 : index + 1);
  return positions;
}

interface ContextMap extends Pick<LineMap, "newLine" | "table"> {
  readonly reordered: boolean;
  readonly conflicts: Int32Array;
  readonly newClaims: Int32Array;
  readonly duplicated: ReadonlySet<string>;
}

function contextualMap(oldLines: readonly string[], newLines: readonly string[]): ContextMap {
  const oldText = oldLines.map(withoutEnding);
  const newText = newLines.map(withoutEnding);
  const oldPositions = uniqueLines(oldText);
  const newPositions = uniqueLines(newText);
  const duplicated = new Set<string>();
  for (const [token, old] of oldPositions) {
    const next = newPositions.get(token);
    if (next !== undefined && (old === 0) !== (next === 0)) duplicated.add(token);
  }
  const table = new Int32Array(oldLines.length + 1);
  const conflicts = new Int32Array(table.length);
  const reverse = new Int32Array(newLines.length + 1);
  let last = 0;
  let reordered = false;
  for (const [token, old] of oldPositions) {
    const next = newPositions.get(token) ?? 0;
    if (old === 0 || next === 0 || token === "") continue;
    table[old] = next;
    reordered ||= next < last;
    last = next;
  }

  // Extend each unique anchor through neighboring identical lines. Both directions are needed:
  // a repeated line may have context on only one side. Never choose between competing contexts.
  const claim = (old: number, next: number) => {
    const previous = table[old];
    if (previous !== 0 && previous !== next) conflicts[old] = 1;
    else table[old] = next;
    const owner = reverse[next] ?? 0;
    if (owner !== 0 && owner !== old) {
      conflicts[old] = 1;
      conflicts[owner] = 1;
    } else reverse[next] = old;
  };
  const extend = (from: number, to: number, step: number) => {
    let position = 0;
    for (let old = from; old !== to; old += step) {
      const token = oldText[old - 1];
      if (token === undefined) break;
      const unique = oldPositions.get(token) === old ? (newPositions.get(token) ?? 0) : 0;
      if (unique !== 0 && token !== "") position = unique;
      else if (position !== 0 && newText[position + step - 1] === token) position += step;
      else position = 0;
      if (position !== 0) claim(old, position);
    }
  };
  extend(1, table.length, 1);
  extend(table.length - 1, 0, -1);
  const newClaims = new Int32Array(reverse.length);
  let claims = 0;
  for (let line = 1; line < reverse.length; line += 1) {
    if (reverse[line] !== 0) claims += 1;
    newClaims[line] = claims;
  }
  return {
    table,
    reordered,
    conflicts,
    newClaims,
    duplicated,
    newLine: (old) => (conflicts[old] === 0 ? table[old] || undefined : undefined),
  };
}

/** Map a small changed stretch inside a moved block, not across a cut or paste boundary. */
function movedHunk(map: ContextMap, line: number): LineHunk | undefined {
  if (map.table[line] !== 0) return undefined;
  let before = line - 1;
  while (before > 0 && map.table[before] === 0 && line - before < maxHunkLines) before -= 1;
  let after = line + 1;
  while (after < map.table.length && map.table[after] === 0 && after - before < maxHunkLines)
    after += 1;
  const left = map.newLine(before);
  const right = map.newLine(after);
  if (
    left === undefined ||
    right === undefined ||
    right <= left + 1 ||
    right - left > maxHunkLines ||
    after - before > maxHunkLines ||
    map.newClaims[right - 1] !== map.newClaims[left]
  )
    return undefined;
  return { oldFrom: before + 1, oldTo: after - 1, newFrom: left + 1, newTo: right - 1 };
}

/** Moves selections and explains losses between the same two text snapshots. */
export interface RangeTracker {
  /** Move a selection. Set `allowAdjusted` to also accept changed regions for display. */
  readonly move: (range: ResultRange, allowAdjusted?: boolean) => ResultRange | undefined;
  /** Explain why a selection could not be moved and report current candidates. */
  readonly describe: (range: ResultRange) => string;
}

/** Track a snapshot pair once, even when many independent selections use it. */
export function createRangeTracker(before: string, after: string): RangeTracker {
  if (before === after) return { move: (range) => range, describe: describeUnmappedRange };
  const old = lineTokens(before);
  const next = lineTokens(after);
  if (old === undefined || next === undefined)
    return { move: () => undefined, describe: describeUnmappedRange };
  const context = contextualMap(old, next);
  let ordered: LineMap | null | undefined;
  const getOrdered = () => {
    if (ordered === undefined) ordered = orderedMap(old, next) ?? null;
    return ordered ?? undefined;
  };
  let lines: string[] | undefined;
  let positions: Map<string, number[]> | undefined;
  const move: RangeTracker["move"] = (range, allowAdjusted = false) => {
    const exact = rebaseRange(range, {
      newLine(line) {
        const moved = context.newLine(line);
        // The last selected line can cross EOF only if the selection excludes its ending.
        if (
          moved !== undefined &&
          (line === range.end.lineNumber || old[line - 1] === next[moved - 1])
        )
          return moved;
        return undefined;
      },
    });
    if (exact !== undefined) return exact;
    if (context.reordered) {
      const moved = relocateInHunk(
        range,
        old,
        next,
        () => movedHunk(context, range.start.lineNumber),
        true,
      );
      if (moved !== undefined || !allowAdjusted) return moved;
    }
    const map = getOrdered();
    if (map === undefined) return undefined;
    // The ordered diff cannot overrule conflicting context or a known different destination.
    const last = lastSelectedLine(range);
    for (let line = range.start.lineNumber; line <= last; line += 1) {
      const known = context.newLine(line);
      const orderedLine = map.newLine(line);
      if (
        context.conflicts[line] ||
        (known !== undefined && known !== orderedLine) ||
        (known === undefined &&
          orderedLine !== undefined &&
          (context.reordered || context.duplicated.has(lineText(old, line))))
      )
        return undefined;
    }
    if (context.reordered) return relocateRange(range, map, (lines ??= after.split("\n")));
    return allowAdjusted
      ? moveRange(range, map, () => (lines ??= after.split("\n")))
      : rebaseOrRelocateRange(range, map);
  };
  const describe: RangeTracker["describe"] = (range) => {
    const line = range.start.lineNumber;
    const token = lineText(old, line);
    positions ??= candidateLines(next);
    const candidates = token.trim() === "" ? [] : (positions.get(token) ?? []);
    const hunk = context.reordered ? movedHunk(context, line) : undefined;
    if (candidates.length === 0 && !context.reordered) {
      const map = getOrdered();
      if (map !== undefined) return describeLostRange(range, map);
    }
    const head = `line ${String(line)} \`${preview(token.trim())}\``;
    if (candidates.length > 0)
      return `${head}: cannot verify the same selection; candidate lines: ${candidates.join(", ")}`;
    if (hunk !== undefined) return describeHunk(head, next, hunk);
    return `${head}: selected text changed, was deleted, or has no unique surrounding context`;
  };
  return { move, describe };
}

/** Keep only a few locations per line; diagnostics never need the whole file. */
function candidateLines(lines: readonly string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    const token = withoutEnding(line);
    const matches = positions.get(token);
    if (matches === undefined) positions.set(token, [index + 1]);
    else if (matches.length < 3) matches.push(index + 1);
  }
  return positions;
}

function describeUnmappedRange(range: ResultRange): string {
  return `line ${String(range.start.lineNumber)}: the snapshots cannot be compared safely`;
}

/**
 * Ranges selected in one text, placed in another text of the same source with their own text
 * unchanged. Every reference and anchor that holds ranges of an earlier or later text uses this to
 * resolve in the text its caller edits. Undefined when any range's own text changed.
 */
export function rangesInText(
  ranges: readonly ResultRange[],
  from: string,
  to: string,
): ResultRange[] | undefined {
  const tracker = createRangeTracker(from, to);
  const moved: ResultRange[] = [];
  for (const range of ranges) {
    const next = tracker.move(range);
    if (next === undefined) return undefined;
    moved.push(next);
  }
  return moved;
}

/** Say where a range that could not be moved stands now, so the caller can pick a new target. */
export function describeLostRange(range: ResultRange, map: LineMap | undefined): string {
  const line = range.start.lineNumber;
  if (map === undefined) return `line ${String(line)}: the file changed too much to follow it`;
  const original = lineText(map.oldLines, line).trim();
  const hunk = hunkAround(map, line);
  const head = `line ${String(line)} \`${preview(original)}\``;
  if (hunk === undefined) return `${head}: changed or moved`;
  return describeHunk(head, map.newLines, hunk);
}

function preview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function describeHunk(head: string, lines: readonly string[], hunk: LineHunk): string {
  if (hunk.newTo < hunk.newFrom) return `${head}: deleted`;
  const now = [];
  for (let at = hunk.newFrom; at <= Math.min(hunk.newTo, hunk.newFrom + 2); at += 1)
    now.push(`${String(at)}| ${preview(lineText(lines, at).trim())}`);
  return `${head}: now ${now.join(" / ")}${hunk.newTo - hunk.newFrom > 2 ? " …" : ""}`;
}
