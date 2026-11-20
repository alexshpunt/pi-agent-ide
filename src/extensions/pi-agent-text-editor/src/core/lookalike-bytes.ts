import { normalizeForFuzzyMatch } from "#src/api/pi-edit-text.ts";

/**
 * The most differences the alignment looks for. A replacement that differs from the original by
 * more is a rewrite, not a retyped copy with a few changes, and is written as sent.
 */
const MAX_DIFFERENCES = 1500;

/**
 * Keeps the original bytes of a replaced span wherever the written text differs from them only
 * by characters that Pi's fuzzy matching treats as equal: special spaces, smart quotes, dashes
 * and the other `normalizeForFuzzyMatch` equivalences. The written text is aligned with the
 * original character by character under that equivalence; an aligned character keeps the
 * original, and a character the model changed is written as sent.
 *
 * When the whole replacement is equal to the original under the equivalence, the model's only
 * change is the look-alike characters themselves, so the text is written as sent. A replacement
 * that differs by more than {@link MAX_DIFFERENCES} is also written as sent.
 */
export function keepLookalikeBytes(original: string, written: string): string {
  if (original === written || original.length === 0 || written.length === 0) return written;
  let prefix = commonPrefixLength(original, written);
  while (
    prefix > 0 &&
    (continuesCharacter(original, prefix) || continuesCharacter(written, prefix))
  )
    prefix -= 1;
  let suffix = Math.min(
    commonSuffixLength(original, written),
    original.length - prefix,
    written.length - prefix,
  );
  while (
    suffix > 0 &&
    (continuesCharacter(original, original.length - suffix) ||
      continuesCharacter(written, written.length - suffix))
  )
    suffix -= 1;
  const before = characters(original.slice(prefix, original.length - suffix));
  const after = characters(written.slice(prefix, written.length - suffix));
  if (sameKeys(before.keys, after.keys)) return written;
  const merged = align(before, after);
  if (merged === undefined) return written;
  return original.slice(0, prefix) + merged + original.slice(original.length - suffix);
}

/** Text as a sequence of characters, each with its equivalence key. */
interface Characters {
  readonly text: string;
  /**
   * Offset in `text` where each character starts, and one more entry for the end. Absent when
   * every character is one code unit.
   */
  readonly starts: Int32Array | undefined;
  /** Equal keys mean equal characters under Pi's fuzzy equivalence. */
  readonly keys: Int32Array;
}

/** Keys of characters whose fuzzy form is not one code point, numbered above all code points. */
const FIRST_COMPOSED_KEY = 0x110000;
const composedKeys = new Map<string, number>();

/**
 * The key of each code unit that is a character on its own, plus one; -1 for a unit that can be
 * part of a longer character, and 0 for one not computed yet.
 */
const UNIT_KEYS = new Int32Array(0x10000);

function characters(text: string): Characters {
  return unitCharacters(text) ?? compositeCharacters(text);
}

/** Text in which every code unit is a character; undefined when one is not. */
function unitCharacters(text: string): Characters | undefined {
  const keys = new Int32Array(text.length);
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    const stored = UNIT_KEYS[unit] ?? 0;
    const key = stored === 0 ? unitKey(unit) : stored;
    if (key < 0) return undefined;
    keys[at] = key - 1;
  }
  return { text, starts: undefined, keys };
}

function unitKey(unit: number): number {
  const key =
    (unit >= 0xd800 && unit <= 0xdfff) || joinsPrevious(unit)
      ? -1
      : keyOf(String.fromCharCode(unit)) + 1;
  UNIT_KEYS[unit] = key;
  return key;
}

/** Characters made of several code units, such as a surrogate pair or a base with its marks. */
function compositeCharacters(text: string): Characters {
  const starts = new Int32Array(text.length + 1);
  const keys = new Int32Array(text.length);
  let count = 0;
  for (let at = 0; at < text.length;) {
    let end = at + codePointLength(text, at);
    while (end < text.length && continuesCharacter(text, end)) end += codePointLength(text, end);
    starts[count] = at;
    keys[count] = keyOf(text.slice(at, end));
    count += 1;
    at = end;
  }
  starts[count] = text.length;
  return { text, starts: starts.subarray(0, count + 1), keys: keys.subarray(0, count) };
}

/** Where character `index` starts in its text. */
function startOf(source: Characters, index: number): number {
  return source.starts === undefined ? index : (source.starts[index] ?? 0);
}

/** The key of one character: its fuzzy form's code point, else a number for the whole form. */
function keyOf(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x80 && character.length === 1) return code;
  // Guards keep the normalization from trimming a whitespace character as trailing space.
  const form = normalizeForFuzzyMatch(`\0${character}\0`).slice(1, -1);
  const first = form.codePointAt(0);
  if (first !== undefined && form.length === codePointLength(form, 0)) return first;
  const known = composedKeys.get(form);
  if (known !== undefined) return known;
  const key = FIRST_COMPOSED_KEY + composedKeys.size;
  composedKeys.set(form, key);
  return key;
}

function sameKeys(left: Int32Array, right: Int32Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

/** Aligns the characters with a shortest edit script; undefined when it needs too many edits. */
function align(original: Characters, written: Characters): string | undefined {
  const a = original.keys;
  const b = written.keys;
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_DIFFERENCES);
  const offset = limit + 1;
  const furthest = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(furthest.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (furthest[offset + k - 1] ?? 0) < (furthest[offset + k + 1] ?? 0))
          ? (furthest[offset + k + 1] ?? 0)
          : (furthest[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;

  // Walk back from the end; pieces come out last first.
  const pieces: string[] = [];
  const keptRun = (from: number, to: number) =>
    original.text.slice(startOf(original, from), startOf(original, to));
  const sent = (index: number) =>
    written.text.slice(startOf(written, index), startOf(written, index + 1));
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = requiredTrace(trace, d);
    const k = x - y;
    const previousK =
      k === -d || (k !== d && (previous[offset + k - 1] ?? 0) < (previous[offset + k + 1] ?? 0))
        ? k + 1
        : k - 1;
    const previousX = previous[offset + previousK] ?? 0;
    const previousY = previousX - previousK;
    const run = Math.min(x - previousX, y - previousY);
    if (run > 0) pieces.push(keptRun(x - run, x));
    x -= run;
    y -= run;
    if (x === previousX) pieces.push(sent(y - 1));
    x = previousX;
    y = previousY;
  }
  const rest = Math.min(x, y);
  if (rest > 0) pieces.push(keptRun(x - rest, x));
  return pieces.reverse().join("");
}

function requiredTrace(trace: readonly Int32Array[], index: number): Int32Array {
  const entry = trace[index];
  if (entry === undefined) throw new Error("The alignment trace is incomplete.");
  return entry;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length += 1;
  return length;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (
    length < limit &&
    left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)
  )
    length += 1;
  return length;
}

function codePointLength(text: string, at: number): number {
  return (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
}

/** Whether the code point composes with the one before it into a single character. */
function joinsPrevious(code: number): boolean {
  if (code < 0x300) return false;
  return (
    /^\p{M}$/u.test(String.fromCodePoint(code)) ||
    // Hangul vowel and trailing jamo compose into the syllable before them.
    (code >= 0x1160 && code <= 0x11ff) ||
    (code >= 0xd7b0 && code <= 0xd7ff) ||
    // Kana voicing marks compose with the kana before them.
    code === 0x3099 ||
    code === 0x309a ||
    code === 0xff9e ||
    code === 0xff9f
  );
}

/** Whether the code unit at `at` continues the character before it instead of starting one. */
function continuesCharacter(text: string, at: number): boolean {
  const unit = text.charCodeAt(at);
  if (Number.isNaN(unit)) return false;
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    const high = text.charCodeAt(at - 1);
    return high >= 0xd800 && high <= 0xdbff;
  }
  return joinsPrevious(text.codePointAt(at) ?? 0);
}
