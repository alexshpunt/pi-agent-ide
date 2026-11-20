/**
 * The copied Pi edit normalization behaves exactly like the installed Pi's own implementation.
 * A Pi upgrade that changes Pi's functions makes this test fail, so the copy can be updated.
 */
import { beforeAll, describe, expect, test } from "vitest";

import {
  getLineEndingAt,
  normalizeForFuzzyMatch,
  normalizeToLF,
  splitBom,
} from "#src/api/pi-edit-text.ts";

interface PiEditDiff {
  normalizeToLF(text: string): string;
  normalizeForFuzzyMatch(text: string): string;
  applyReplacementsToOriginal(
    content: string,
    replacements: readonly { matchIndex: number; matchLength: number; newText: string }[],
  ): string;
}
interface PiText {
  splitBom(content: string): { bom: string; text: string };
}

let pi: PiEditDiff;
let piText: PiText;
beforeAll(async () => {
  // Pi does not export these modules; load them next to its package entry point.
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  pi = (await import(new URL("./core/tools/edit-diff.js", entry).href)) as PiEditDiff;
  piText = (await import(new URL("./utils/text.js", entry).href)) as PiText;
}, 30_000);

const PIECES = [
  "\n",
  "\r\n",
  "\r",
  "\uFEFF",
  " ",
  "  ",
  "\t",
  "\u00A0",
  "\u2002",
  "\u202F",
  "\u3000",
  "\u200B",
  "\u2018",
  "\u201D",
  "\u2014",
  "\u2212",
  "e\u0301",
  "\u00E9",
  "\uFB01",
  "\u2026",
  "\uFF21",
  "\u1100\u1161",
  "\uFF76\uFF9E",
  "😀",
  "x",
  "word",
] as const;

function generated(seed: number): string {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 4_294_967_296;
  };
  let text = "";
  const length = Math.floor(next() * 40);
  for (let index = 0; index < length; index += 1)
    text += PIECES[Math.floor(next() * PIECES.length)] ?? "";
  return text;
}

const SAMPLES = Array.from({ length: 400 }, (_, seed) => generated(seed + 1));

describe("copied Pi edit normalization", () => {
  test("splitBom, normalizeToLF and normalizeForFuzzyMatch equal Pi's", () => {
    for (const sample of SAMPLES) {
      expect(splitBom(sample)).toEqual(piText.splitBom(sample));
      expect(normalizeToLF(sample)).toBe(pi.normalizeToLF(sample));
      expect(normalizeForFuzzyMatch(sample)).toBe(pi.normalizeForFuzzyMatch(sample));
    }
  });

  test("getLineEndingAt gives the line ending Pi writes for new text at an offset", () => {
    for (const sample of SAMPLES) {
      const { text } = splitBom(sample);
      const normalized = normalizeToLF(text);
      for (let at = 0; at <= normalized.length; at += 1) {
        // The original offset of a normalized one: each CRLF before it adds one character.
        let original = 0;
        for (let seen = 0; seen < at; seen += 1)
          original += text.startsWith("\r\n", original) ? 2 : 1;
        const written = pi.applyReplacementsToOriginal(text, [
          { matchIndex: at, matchLength: 0, newText: "<\n>" },
        ]);
        const inserted = written.slice(original, written.length - (text.length - original));
        expect(inserted, JSON.stringify({ text, at })).toBe(`<${getLineEndingAt(text, original)}>`);
      }
    }
  });
});
