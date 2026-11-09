import { createHash } from "node:crypto";

import { createTextDocument, type TextLine } from "./text-document.ts";

/**
 * Line anchors name a line by its content, not by its number, and are derived from the current
 * text in one pass, without a stored map.
 *
 * - A line whose text occurs once in the file is named by that text alone, so its anchor survives
 *   any edit elsewhere until the line itself changes or a copy of it appears.
 * - A repeated line is named by the nearest unique line above it (its landmark), the number of
 *   times its text occurred since that landmark, and its text. Edits outside the stretch between
 *   the landmark and the line leave the anchor intact.
 * - With no unique line above, the start of the file is the landmark.
 */

/** Crockford base32: digits and capitals without I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ANCHOR_LENGTH = 7;
const START_OF_FILE = "";

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

  const anchors: string[] = [];
  let landmark = START_OF_FILE;
  let sinceLandmark = new Map<string, number>();
  for (const line of lines) {
    if (occurrences.get(line) === 1) {
      landmark = encode(`u\0${line}`);
      sinceLandmark = new Map();
      anchors.push(landmark);
      continue;
    }

    const nth = (sinceLandmark.get(line) ?? 0) + 1;
    sinceLandmark.set(line, nth);
    anchors.push(encode(`r\0${landmark}\0${nth}\0${line}`));
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
