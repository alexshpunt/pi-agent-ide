import { createHash } from "node:crypto";

import { createTextDocument, type TextLine } from "./text-document.ts";

/**
 * Line anchors name a line by its content, not by its number, and are derived from the current
 * text in one pass, without a stored map.
 *
 * - A line whose text occurs once in the file is named by that text alone, so its anchor survives
 *   any edit elsewhere until the line itself changes or a copy of it appears.
 * - A repeated line is named by a landmark, the nearest unique line above or below it, the number
 *   of times its text occurs between the landmark and the line, and its text. Edits outside the
 *   stretch between the landmark and the line leave the anchor intact, as long as they don't add
 *   or remove a copy of its text before the next unique line on the other side.
 * - The landmark comes from the line's own block, so moving a neighbouring block keeps it: a
 *   column-0 `}` or `};` ends a block, and the side reached without crossing a block end wins.
 *   A `template <typename T>` line takes the declaration below it, a closing brace the line above.
 *   When both sides or neither qualify, the nearer side wins; with no unique line on a side, the
 *   edge of the file stands in.
 * - A repeated line also counts its text on the other side, up to the nearest unique line there,
 *   but not which line that is. A copy inserted or removed on either side then makes the anchor
 *   stale instead of handing it to a neighbouring copy, and moving the neighbouring block still
 *   keeps it.
 * - A blank line is named by its landmarks on both sides. A blank line between two blocks then
 *   stops matching when either block moves, instead of matching a blank line next to the moved
 *   block in its new place.
 */

/** Crockford base32: digits and capitals without I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ANCHOR_LENGTH = 7;
const EDGE_OF_FILE = "";

/** The exact shape of one anchor: seven characters, 35 bits. */
export const LINE_ANCHOR_PATTERN = /^[0-9A-HJKMNP-TV-Z]{7}$/;

/** The anchor at the start of a presented line, such as `K7M2QX4|const a = 1;`. */
export const PRESENTED_LINE_ANCHOR_PATTERN = /^\s*([0-9A-HJKMNP-TV-Z]{7})\|/;

export function isLineAnchor(value: string): boolean {
  return LINE_ANCHOR_PATTERN.test(value);
}

function encode(input: string): string {
  const digest = createHash("sha1").update(input).digest();
  // The first 40 bits, less the lowest five: 35 bits are seven base32 characters.
  let bits = Math.floor(
    ((digest[0] ?? 0) * 2 ** 32 +
      (digest[1] ?? 0) * 2 ** 24 +
      (digest[2] ?? 0) * 2 ** 16 +
      (digest[3] ?? 0) * 2 ** 8 +
      (digest[4] ?? 0)) /
      32,
  );
  let token = "";
  for (let index = 0; index < ANCHOR_LENGTH; index += 1) {
    token = ALPHABET.charAt(bits % 32) + token;
    bits = Math.floor(bits / 32);
  }
  return token;
}

/**
 * A column-0 closing brace ends a top-level block, such as a C++ function or class. A CRLF line
 * keeps its CR in its text, so the brace may be followed by one.
 */
function endsBlock(line: string): boolean {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  return text === "}" || text === "};";
}

interface Landmark {
  /** The anchor of the nearest unique line on one side, or the edge of the file. */
  readonly anchor: string;
  /** Its line index: -1 or the line count when the edge of the file is the landmark. */
  readonly at: number;
  /** How many times the line's text occurs from the landmark up to the line, the line included. */
  readonly nth: number;
}

/** The landmark of every line on one side: above for step 1, below for step -1. */
function landmarks(
  lines: readonly string[],
  unique: readonly boolean[],
  step: 1 | -1,
): readonly (Landmark | undefined)[] {
  const result: (Landmark | undefined)[] = Array.from({ length: lines.length });
  let anchor = EDGE_OF_FILE;
  let at = step === 1 ? -1 : lines.length;
  let sinceLandmark = new Map<string, number>();
  for (let index = at + step; index >= 0 && index < lines.length; index += step) {
    const line = lines[index] ?? "";
    if (unique[index] === true) {
      anchor = encode(`u\0${line}`);
      at = index;
      sinceLandmark = new Map();
      continue;
    }
    const nth = (sinceLandmark.get(line) ?? 0) + 1;
    sinceLandmark.set(line, nth);
    result[index] = { anchor, at, nth };
  }
  return result;
}

/**
 * The side whose landmark belongs to the line's own block: reached without crossing a block end.
 * When both or neither do, the nearer side; above on a tie and when the file has no unique line.
 */
function sideOf(
  index: number,
  line: string,
  up: Landmark,
  down: Landmark,
  blockEndsIn: (from: number, to: number) => boolean,
): "above" | "below" {
  const hasUp = up.anchor !== EDGE_OF_FILE;
  const hasDown = down.anchor !== EDGE_OF_FILE;
  const upInBlock = hasUp && !blockEndsIn(up.at, index);
  const downInBlock = hasDown && !endsBlock(line) && !blockEndsIn(index + 1, down.at);
  if (upInBlock !== downInBlock) {
    return upInBlock ? "above" : "below";
  }
  if (!hasUp && !hasDown) {
    return "above";
  }
  return index - up.at <= down.at - index ? "above" : "below";
}

const cache = new WeakMap<readonly string[], readonly string[]>();

/** The anchor of every line, in order. The same list returns the same array. */
export function lineAnchors(lines: readonly string[]): readonly string[] {
  const cached = cache.get(lines);
  if (cached !== undefined) {
    return cached;
  }

  const occurrences = new Map<string, number>();
  for (const line of lines) {
    occurrences.set(line, (occurrences.get(line) ?? 0) + 1);
  }

  const unique = lines.map((line) => occurrences.get(line) === 1);
  const above = landmarks(lines, unique, 1);
  const below = landmarks(lines, unique, -1);
  // blockEndsBefore[i] counts the block ends among lines 0..i-1.
  const blockEndsBefore = [0];
  for (const line of lines) {
    blockEndsBefore.push((blockEndsBefore.at(-1) ?? 0) + (endsBlock(line) ? 1 : 0));
  }
  const blockEndsIn = (from: number, to: number): boolean =>
    from < to && (blockEndsBefore[to] ?? 0) - (blockEndsBefore[from] ?? 0) > 0;

  const anchors: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (unique[index] === true) {
      anchors.push(encode(`u\0${line}`));
      continue;
    }
    const up = above[index] as Landmark;
    const down = below[index] as Landmark;
    if (line.trim() === "") {
      anchors.push(encode(`ab\0${up.anchor}\0${up.nth}\0${down.anchor}\0${down.nth}\0${line}`));
      continue;
    }
    anchors.push(
      encode(
        sideOf(index, line, up, down, blockEndsIn) === "above"
          ? `a\0${up.anchor}\0${up.nth}\0${down.nth}\0${line}`
          : `b\0${down.anchor}\0${down.nth}\0${up.nth}\0${line}`,
      ),
    );
  }

  cache.set(lines, anchors);
  return anchors;
}

const documentCache = new WeakMap<readonly TextLine[], readonly string[]>();

/**
 * The anchor of every line of a text document. Documents of large files are shared and frozen,
 * so the anchors of one are computed once however many tools ask.
 */
export function documentLineAnchors(lines: readonly TextLine[]): readonly string[] {
  const cached = documentCache.get(lines);
  if (cached !== undefined) {
    return cached;
  }
  const anchors = lineAnchors(lines.map((line) => line.content));
  documentCache.set(lines, anchors);
  return anchors;
}

/**
 * Anchors for selected zero-based line indexes. The complete document is still needed to identify
 * unique landmarks and count copies, but only requested lines and their landmarks are hashed.
 * This is for presentation only: resolving an anchor must still check the complete document for
 * collisions with lines that were not presented.
 */
export function documentSelectedLineAnchors(
  lines: readonly TextLine[],
  indexes: ReadonlySet<number>,
): ReadonlyMap<number, string> {
  const selected = new Set(
    [...indexes].filter((index) => Number.isInteger(index) && index >= 0 && index < lines.length),
  );
  const result = new Map<number, string>();
  if (selected.size === 0) return result;

  const cached = documentCache.get(lines);
  if (cached !== undefined) {
    for (const index of selected) result.set(index, cached[index] as string);
    return result;
  }

  const occurrences = new Map<string, number>();
  for (const line of lines) {
    occurrences.set(line.content, (occurrences.get(line.content) ?? 0) + 1);
  }
  const repeated = new Set<string>();
  for (const index of selected) {
    const content = (lines[index] as TextLine).content;
    if (occurrences.get(content) === 1) result.set(index, encode(`u\0${content}`));
    else repeated.add(content);
  }
  if (repeated.size === 0) return result;

  interface SelectedLandmark {
    readonly at: number;
    readonly nth: number;
    readonly crossedBlockEnd: boolean;
  }
  const sweep = (step: 1 | -1): Map<number, SelectedLandmark> => {
    const found = new Map<number, SelectedLandmark>();
    let at = step === 1 ? -1 : lines.length;
    let crossedBlockEnd = false;
    const sinceLandmark = new Map<string, number>();
    for (let index = at + step; index >= 0 && index < lines.length; index += step) {
      const content = (lines[index] as TextLine).content;
      if (occurrences.get(content) === 1) {
        at = index;
        // The upward interval includes its landmark; the downward interval excludes it.
        crossedBlockEnd = step === 1 && endsBlock(content);
        sinceLandmark.clear();
        continue;
      }
      if (repeated.has(content)) {
        const nth = (sinceLandmark.get(content) ?? 0) + 1;
        sinceLandmark.set(content, nth);
        if (selected.has(index)) found.set(index, { at, nth, crossedBlockEnd });
      }
      crossedBlockEnd ||= endsBlock(content);
    }
    return found;
  };
  const above = sweep(1);
  const below = sweep(-1);
  const landmarkAnchors = new Map<number, string>();
  const anchorAt = (index: number): string => {
    if (index < 0 || index >= lines.length) return EDGE_OF_FILE;
    let anchor = landmarkAnchors.get(index);
    if (anchor === undefined) {
      anchor = encode(`u\0${(lines[index] as TextLine).content}`);
      landmarkAnchors.set(index, anchor);
    }
    return anchor;
  };
  for (const index of selected) {
    if (result.has(index)) continue;
    const line = (lines[index] as TextLine).content;
    const upper = above.get(index) as SelectedLandmark;
    const lower = below.get(index) as SelectedLandmark;
    const up: Landmark = { at: upper.at, nth: upper.nth, anchor: anchorAt(upper.at) };
    const down: Landmark = { at: lower.at, nth: lower.nth, anchor: anchorAt(lower.at) };
    if (line.trim() === "") {
      result.set(
        index,
        encode(`ab\0${up.anchor}\0${up.nth}\0${down.anchor}\0${down.nth}\0${line}`),
      );
      continue;
    }
    const blockEndsIn = (from: number) =>
      from === up.at ? upper.crossedBlockEnd : lower.crossedBlockEnd;
    result.set(
      index,
      encode(
        sideOf(index, line, up, down, blockEndsIn) === "above"
          ? `a\0${up.anchor}\0${up.nth}\0${down.nth}\0${line}`
          : `b\0${down.anchor}\0${down.nth}\0${up.nth}\0${line}`,
      ),
    );
  }
  return result;
}

/** The anchors of the lines of `content`, split as Read splits them. */
export function textLineAnchors(source: string, content: string): readonly string[] {
  return documentLineAnchors(createTextDocument(source, content).lines);
}

/** The 1-based numbers of the lines that produce `anchor`: none, one, or several. */
export function linesWithAnchor(anchors: readonly string[], anchor: string): readonly number[] {
  const numbers: number[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index] === anchor) {
      numbers.push(index + 1);
    }
  }
  return numbers;
}
