import { BOM, NBSP, NNBSP, SHY, WJ, ZWSP, type Variant } from "./fixtures.ts";

/** Short names for the special characters the fixture uses; others print as U+XXXX. */
const NAMES: Record<string, string> = {
  [BOM]: "BOM",
  "\r": "CR",
  "\n": "LF",
  "\t": "TAB",
  [NBSP]: "NBSP",
  [NNBSP]: "NNBSP",
  [ZWSP]: "ZWSP",
  [WJ]: "WJ",
  [SHY]: "SHY",
};

export function specialName(character: string): string {
  const code = `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
  return NAMES[character] ? `${NAMES[character]} ${code}` : code;
}

/** Count line breaks, tabs, format and control characters, and every space other than U+0020. */
export function specials(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const character of text)
    if (character !== " " && /[\p{Cf}\p{Cc}\p{Zs}]/u.test(character))
      counts[character] = (counts[character] ?? 0) + 1;
  return counts;
}

export type GradeResult = "pass" | "unchanged" | "wrong" | "missing";

export interface Grade {
  result: GradeResult;
  /** Whether the intended change is in the file; set for wrong files. */
  intended?: boolean;
  /** Special characters the file has fewer of than expected, by name. */
  lost: Record<string, number>;
  /** Special characters the file has more of than expected, by name. */
  added: Record<string, number>;
  /** First line (1-based, split on LF) whose bytes differ from the expected file. */
  firstDifferentLine?: number;
}

/** Grade the final bytes of one run against the expected bytes, byte for byte. */
export function grade(
  variant: Variant,
  original: Buffer,
  expected: Buffer,
  final: Buffer | undefined,
): Grade {
  const empty = { lost: {}, added: {} };
  if (!final) return { result: "missing", ...empty };
  if (final.equals(expected)) return { result: "pass", ...empty };
  if (final.equals(original)) return { result: "unchanged", ...empty };
  const want = expected.toString("utf8");
  const got = final.toString("utf8");
  const wanted = specials(want);
  const actual = specials(got);
  const lost: Record<string, number> = {};
  const added: Record<string, number> = {};
  for (const character of new Set([...Object.keys(wanted), ...Object.keys(actual)])) {
    const delta = (actual[character] ?? 0) - (wanted[character] ?? 0);
    if (delta < 0) lost[specialName(character)] = -delta;
    if (delta > 0) added[specialName(character)] = delta;
  }
  const wantLines = want.split("\n");
  const gotLines = got.split("\n");
  let line = 0;
  while (line < wantLines.length && wantLines[line] === gotLines[line]) line++;
  return {
    result: "wrong",
    intended: variant.intended(got),
    lost,
    added,
    firstDifferentLine: line + 1,
  };
}

function counts(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
}

/** One-line description of a grade for the report. */
export function describeGrade(value: Grade): string {
  if (value.result !== "wrong") return value.result;
  const parts = [`wrong: intended change ${value.intended ? "made" : "missing"}`];
  if (Object.keys(value.lost).length) parts.push(`lost ${counts(value.lost)}`);
  if (Object.keys(value.added).length) parts.push(`added ${counts(value.added)}`);
  parts.push(`first difference on line ${value.firstDifferentLine}`);
  return parts.join("; ");
}
