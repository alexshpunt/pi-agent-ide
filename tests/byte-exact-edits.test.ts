/**
 * Edit tools change exactly the selected bytes and nothing else. Every edit is checked against the
 * reference model `file[:start] + text + file[end:]`, byte for byte, on files built from the
 * pieces that tools used to rewrite: a BOM, CRLF, lone CR, NUL, invisible and combining
 * characters, astral characters, trailing whitespace, and a missing final LF.
 *
 * Literal text selects and writes the way Pi's edit does: a selected span never splits a CRLF,
 * and line breaks in the sent text take the line ending of the line where the span starts. A
 * literal that is not in the file matches without the BOM and with CRLF and CR as LF, and then
 * fuzzily; Pi's own normalization functions are the reference for both.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { ResultTargetStore, type ResultRange } from "pi-agent-resource";
import { createTextContentConverter, linesWithAnchor, textLineAnchors } from "pi-agent-text";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createExactTextAnchorResolver } from "#pi-agent-text-anchor-exact/src/anchor.ts";
import { createLineHashAnchorResolver } from "#pi-agent-text-anchor-line-hash/src/anchor.ts";
import type { TextMutationToolRegistration } from "#pi-agent-text-editor/api/mutation-tool.ts";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  TEXT_SEARCH_ANCHOR_KIND,
} from "#pi-agent-text-editor/api/plugin-protocol.ts";
import { createResultTargetAnchors } from "#pi-agent-text-editor/core/result-target-anchors.ts";
import { createTextEditorCore } from "#pi-agent-text-editor/core/text-editor-core.ts";
import { createTextTool } from "#pi-agent-text-editor/core/text-mutation.ts";
import { ToolCallInterceptionRenderStore } from "#pi-agent-text-editor/core/tool-call-interceptor/rendering.ts";
import { copyMutationTool } from "#pi-agent-text-editor/tools/tool-text-copy.ts";
import { deleteMutationTool } from "#pi-agent-text-editor/tools/tool-text-delete.ts";
import { insertMutationTool } from "#pi-agent-text-editor/tools/tool-text-insert.ts";
import { moveMutationTool } from "#pi-agent-text-editor/tools/tool-text-move.ts";
import { replaceMutationTool } from "#pi-agent-text-editor/tools/tool-text-replace.ts";
import { writeMutationTool } from "#pi-agent-text-editor/tools/tool-text-write.ts";
import { createFilesystemWriteResolver } from "#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/src/resolver.ts";

const BOM = "\uFEFF";
/** Hard pieces of a file. Words keep most literals unique. */
const PIECES = [
  "\n",
  "\r\n",
  "\r",
  "\0",
  "\u200B",
  "\u2060",
  "\u00AD",
  "\u00A0",
  "\u202F",
  "e\u0301",
  "😀",
  "𝄞",
  "\t",
  " ",
  "  \t",
  "}",
  BOM,
] as const;
const WORDS = ["alpha", "beta", "gamma", "delta", "value", "export", "const", "x"] as const;

/** Pi's own edit normalization, loaded from the installed Pi as the reference for literals. */
let pi: {
  normalizeToLF(text: string): string;
  normalizeForFuzzyMatch(text: string): string;
};
beforeAll(async () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  pi = (await import(new URL("./core/tools/edit-diff.js", entry).href)) as typeof pi;
}, 30_000);

/** A literal's span never splits a CRLF: it covers the whole CRLF, as in Pi's edit. */
function literalSpan(
  content: string,
  span: { from: number; to: number },
): { from: number; to: number } {
  return {
    from:
      content[span.from] === "\n" && content[span.from - 1] === "\r" ? span.from - 1 : span.from,
    to: content[span.to - 1] === "\r" && content[span.to] === "\n" ? span.to + 1 : span.to,
  };
}

/**
 * The line ending Pi's edit gives line breaks it writes at `at`: that of the line holding `at`,
 * or of the last line break for an unterminated last line. A file without LF uses a lone CR if
 * it has one.
 */
function lineEndingAt(content: string, at: number): string {
  if (!content.includes("\n")) return content.includes("\r") ? "\r" : "\n";
  const next = content.indexOf("\n", at);
  const lineFeed = next === -1 ? content.lastIndexOf("\n") : next;
  return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/** Text sent for a literal selection as written at `at`. */
function sentText(content: string, at: number, text: string): string {
  return text.replace(/\r\n?/gu, "\n").replaceAll("\n", lineEndingAt(content, at));
}

/** The source offset of an offset in `normalizeToLF(text)`: before the CR of a CRLF at its LF. */
function sourceOffset(text: string, normalized: number): number {
  let at = 0;
  for (let seen = 0; seen < normalized; seen += 1) at += text.startsWith("\r\n", at) ? 2 : 1;
  return at;
}

function starts(content: string, value: string): number[] {
  const result: number[] = [];
  for (let at = content.indexOf(value); at !== -1; at = content.indexOf(value, at + 1))
    result.push(at);
  return result;
}

/** A small deterministic PRNG, so a failing seed replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (limit: number) => Math.floor(next() * limit);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)] as T;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Random = ReturnType<typeof random>;

let wordCounter = 0;
function piece(rng: Random): string {
  if (rng.chance(0.45)) return `${rng.pick(WORDS)}${String(wordCounter++)}`;
  return rng.pick(PIECES);
}

function bombFile(rng: Random): string {
  const special = ["", "\n", "\r\n", "\r", BOM, `${BOM}\n`];
  if (rng.chance(0.08)) return rng.pick(special);
  let text = rng.chance(0.4) ? BOM : "";
  const length = 5 + rng.int(60);
  for (let index = 0; index < length; index += 1) text += piece(rng);
  if (rng.chance(0.3)) text += rng.pick(["\n", "\r\n", "\r", " \t"]);
  return text;
}

function insertedText(rng: Random): string {
  const length = rng.int(5);
  let text = "";
  for (let index = 0; index < length; index += 1) text += piece(rng);
  return text;
}

function occurrences(content: string, value: string): number {
  let count = 0;
  for (let at = content.indexOf(value); at !== -1; at = content.indexOf(value, at + 1)) count += 1;
  return count;
}

/** Interesting offsets: the start, the end, after the BOM, between CR and LF, around breaks. */
function offsets(content: string): number[] {
  const result = new Set([0, content.length]);
  if (content.startsWith(BOM)) result.add(1);
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\r" || character === "\n") {
      result.add(index);
      result.add(index + 1);
    }
  }
  return [...result].sort((left, right) => left - right);
}

function offset(rng: Random, content: string, near?: number): number {
  if (near !== undefined && rng.chance(0.3)) return Math.min(content.length, near);
  if (rng.chance(0.5)) return rng.pick(offsets(content));
  return rng.int(content.length + 1);
}

/** A span whose text occurs once, grown from a random start, or undefined. */
function uniqueSpan(
  rng: Random,
  content: string,
  near?: number,
): { from: number; to: number } | undefined {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let from = offset(rng, content, near);
    let to = Math.min(content.length, from + 1 + rng.int(12));
    if (from === content.length) from = Math.max(0, from - 1 - rng.int(4));
    while (to <= content.length && to > from) {
      if (occurrences(content, content.slice(from, to)) === 1) {
        // Avoid splitting a surrogate pair: a lone half cannot round-trip through UTF-8.
        if (isSplitSurrogate(content, from) || isSplitSurrogate(content, to)) break;
        return { from, to };
      }
      to += 1;
    }
  }
  return undefined;
}

function isSplitSurrogate(content: string, at: number): boolean {
  const code = content.charCodeAt(at);
  return at > 0 && at < content.length && code >= 0xdc00 && code <= 0xdfff;
}

/** Start and end offsets of each LF-terminated line. */
function lineSpans(content: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let from = 0;
  for (let lf = content.indexOf("\n"); lf !== -1; lf = content.indexOf("\n", from)) {
    spans.push({ from, to: lf + 1 });
    from = lf + 1;
  }
  if (from < content.length) spans.push({ from, to: content.length });
  return spans;
}

function position(content: string, at: number): { lineNumber: number; column: number } {
  const before = content.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { lineNumber: occurrences(before, "\n") + 1, column: at - lineStart };
}

let cwd = "";
beforeEach(async () => {
  const base = path.resolve(".tmp/byte-exact-tests");
  await mkdir(base, { recursive: true });
  cwd = await mkdtemp(path.join(base, "workspace-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Tool arguments as an agent sends them. */
type ToolInput = Readonly<Record<string, unknown>>;
async function harness() {
  const store = new ResultTargetStore();
  const core = createTextEditorCore();
  const converter = createTextContentConverter();
  const tools = [
    replaceMutationTool,
    deleteMutationTool,
    insertMutationTool,
    copyMutationTool,
    moveMutationTool,
    writeMutationTool,
  ];
  for (const tool of tools) core.addMutationTool(tool);
  await core.registerPlugin({
    id: "byte-exact-test",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addAnchorResolver(createResultTargetAnchors(store));
      api.addAnchorResolver({
        resolver: createLineHashAnchorResolver(),
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "major",
      });
      api.addAnchorResolver({
        resolver: createExactTextAnchorResolver({
          fuzzyEnabled: true,
          threshold: 0.8,
          exactCandidateLimit: 20,
          fuzzyCandidateLimit: 5,
          maxFileSizeMiB: 20,
          maxQuerySizeKiB: 1024,
          seedLimit: 3,
          blockLineVariance: 2,
          contextLines: 15,
          timeoutMs: 2000,
        }),
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        priority: 10_000,
      });
      // The real filesystem resolver and text converter, as the IDE reads and writes files.
      api.addResolver({
        resolver: createFilesystemWriteResolver({
          async convert(input, context) {
            const attempt = await converter.tryConvert(input, context);
            if (attempt.kind !== "converted") throw new Error(`${input.source} is not text`);
            return attempt.content;
          },
        }),
      });
    },
  });
  const annotations = new ToolCallInterceptionRenderStore();
  const run = async (registration: TextMutationToolRegistration, input: ToolInput) => {
    const result = await createTextTool(
      core,
      registration,
      annotations,
      () => undefined,
      store,
    ).execute("call", input, undefined, undefined, { cwd } as ExtensionToolContext);
    return {
      result,
      text: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    };
  };
  /** A result that selects text, as a Read range or a Search :match or :line reference does. */
  const select = (file: string, content: string, ranges: readonly ResultRange[]) =>
    store.register([{ source: file, expectedContent: content, ranges }], cwd);
  return { run, select };
}

const file = (name: string) => path.join(cwd, name);
const bytes = (name: string) => readFile(file(name));
const put = (name: string, content: string) => writeFile(file(name), content);

/** The text a result view shows for each final line: `Final text, lines A–B:` and its lines. */
function shownFinalLines(text: string): Map<number, string> {
  const rows = text.split("\n");
  const shown = new Map<number, string>();
  for (let index = 0; index < rows.length; index += 1) {
    const header = /^Final text, lines (\d+)–(\d+):$/u.exec(rows[index] ?? "");
    if (header === null) continue;
    const first = Number(header[1]);
    const last = Number(header[2]);
    for (let line = first; line <= last; line += 1)
      shown.set(line, rows[index + 1 + line - first] ?? "");
    const after = rows[index + 2 + last - first];
    if (after === "\\ No newline at end of file") shown.set(last + 1, after);
  }
  return shown;
}

/** The result view shows each final line as it is, and marks an end without a final LF. */
function expectExactView(text: string, content: string): void {
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const shown = shownFinalLines(text);
  for (const [line, row] of shown) {
    if (row === "\\ No newline at end of file") {
      expect(line - 1).toBe(Math.max(1, lines.length));
      expect(content.endsWith("\n")).toBe(false);
    } else expect(row).toBe(lines[line - 1] ?? "");
  }
  const last = Math.max(1, lines.length);
  if (shown.has(last) && !content.endsWith("\n")) expect(shown.get(last + 1)).toBeDefined();
}

type Harness = Awaited<ReturnType<typeof harness>>;

interface Operation {
  readonly name: string;
  readonly run: () => Promise<{ readonly text: string; readonly applied: boolean }>;
  /** Expected bytes of each file after the operation, or undefined when it must refuse. */
  readonly expected: Readonly<Record<string, string>> | undefined;
}

/** Builds one random operation on `main.txt` (and `other.txt` for transfers). */
function randomOperation(
  rng: Random,
  h: Harness,
  main: string,
  other: string,
  near: number | undefined,
): Operation | undefined {
  const text = insertedText(rng);
  const splice = (content: string, from: number, to: number, insert: string) =>
    content.slice(0, from) + insert + content.slice(to);
  const outcome = (applied: boolean, result: { text: string; result: { details: unknown } }) => ({
    text: result.text,
    applied,
  });
  const call = (tool: TextMutationToolRegistration, input: Record<string, unknown>) => async () => {
    const result = await h.run(tool, input);
    const effect = (result.result.details as { effect?: string }).effect;
    return outcome(effect !== "not-applied" && result.result.isError !== true, result);
  };
  const kind = rng.int(15);
  const lines = lineSpans(main);
  const anchors = textLineAnchors(file("main.txt"), main);
  const uniqueLine = () => {
    const candidates = lines
      .map((_, index) => index)
      .filter((index) => linesWithAnchor(anchors, anchors[index] ?? "").length === 1);
    return candidates.length === 0 ? undefined : rng.pick(candidates);
  };

  switch (kind) {
    case 0:
    case 1: {
      // Replace or delete a unique literal.
      const span = uniqueSpan(rng, main, near);
      if (span === undefined) return undefined;
      const insert = kind === 1 ? "" : text;
      const { from, to } = literalSpan(main, span);
      return {
        name: `${kind === 1 ? "delete" : "replace"} literal ${JSON.stringify(main.slice(span.from, span.to))} -> ${JSON.stringify(insert)}`,
        run: call(kind === 1 ? deleteMutationTool : replaceMutationTool, {
          path: "main.txt",
          start: main.slice(span.from, span.to),
          ...(kind === 1 ? {} : { newText: insert }),
        }),
        expected: { "main.txt": splice(main, from, to, sentText(main, from, insert)) },
      };
    }
    case 2: {
      // Replace between two unique literals.
      const first = uniqueSpan(rng, main, near);
      const second = uniqueSpan(rng, main);
      if (
        first === undefined ||
        second === undefined ||
        second.from < first.from ||
        second.to < first.to
      )
        return undefined;
      return {
        name: `replace literal range ${JSON.stringify(main.slice(first.from, second.to))}`,
        run: call(replaceMutationTool, {
          path: "main.txt",
          start: main.slice(first.from, first.to),
          end: main.slice(second.from, second.to),
          newText: text,
        }),
        expected: (() => {
          const from = literalSpan(main, first).from;
          const to = literalSpan(main, second).to;
          return { "main.txt": splice(main, from, to, sentText(main, from, text)) };
        })(),
      };
    }
    case 3:
    case 4: {
      // Replace or delete whole lines through line anchors; a line covers its own LF.
      const first = uniqueLine();
      const last = uniqueLine();
      if (first === undefined || last === undefined) return undefined;
      const [low, high] = first <= last ? [first, last] : [last, first];
      const insert = kind === 4 ? "" : text;
      return {
        name: `${kind === 4 ? "delete" : "replace"} lines ${String(low + 1)}-${String(high + 1)} -> ${JSON.stringify(insert)}`,
        run: call(kind === 4 ? deleteMutationTool : replaceMutationTool, {
          path: "main.txt",
          start: anchors[low],
          ...(low === high ? {} : { end: anchors[high] }),
          ...(kind === 4 ? {} : { newText: insert }),
        }),
        expected: {
          "main.txt": splice(main, lines[low]?.from ?? 0, lines[high]?.to ?? main.length, insert),
        },
      };
    }
    case 5: {
      // A Search :match reference selects exactly its characters.
      const span = uniqueSpan(rng, main, near);
      if (span === undefined) return undefined;
      const reference = h.select(file("main.txt"), main, [
        { start: position(main, span.from), end: position(main, span.to) },
      ]);
      return {
        name: `replace match ${JSON.stringify(main.slice(span.from, span.to))}`,
        run: call(replaceMutationTool, { path: "main.txt", start: reference, newText: text }),
        expected: { "main.txt": splice(main, span.from, span.to, text) },
      };
    }
    case 6: {
      // A Search :line or Read range selects whole lines with their LFs.
      if (lines.length === 0) return undefined;
      const low = rng.int(lines.length);
      const high = Math.min(lines.length - 1, low + rng.int(3));
      const end =
        high + 1 < lines.length || main.endsWith("\n")
          ? { lineNumber: high + 2, column: 0 }
          : position(main, main.length);
      const reference = h.select(file("main.txt"), main, [
        { start: { lineNumber: low + 1, column: 0 }, end, linewise: true },
      ]);
      return {
        name: `replace line selection ${String(low + 1)}-${String(high + 1)}`,
        run: call(replaceMutationTool, { path: "main.txt", start: reference, newText: text }),
        expected: {
          "main.txt": splice(main, lines[low]?.from ?? 0, lines[high]?.to ?? 0, text),
        },
      };
    }
    case 7: {
      // Insert at an exact boundary adds exactly the text.
      const span = uniqueSpan(rng, main, near);
      if (span === undefined || text.length === 0) return undefined;
      const before = rng.chance(0.5);
      const literal = literalSpan(main, span);
      const at = before ? literal.from : literal.to;
      return {
        name: `insert ${before ? "before" : "after"} literal`,
        run: call(insertMutationTool, {
          path: "main.txt",
          anchor: main.slice(span.from, span.to),
          newText: text,
          before,
        }),
        expected: { "main.txt": splice(main, at, at, sentText(main, at, text)) },
      };
    }
    case 8:
    case 9: {
      // Copy or move a literal over a literal destination in another file.
      const source = uniqueSpan(rng, main, near);
      const target = uniqueSpan(rng, other);
      if (source === undefined || target === undefined) return undefined;
      const literal = main.slice(source.from, source.to);
      // Transferred text is file text: it keeps its bytes.
      const from = literalSpan(main, source);
      const to = literalSpan(other, target);
      const moved = main.slice(from.from, from.to);
      const tool = kind === 8 ? copyMutationTool : moveMutationTool;
      return {
        name: `${tool.name} literal ${JSON.stringify(literal)}`,
        run: call(tool, {
          path: "main.txt",
          start: literal,
          target: "other.txt",
          targetStart: other.slice(target.from, target.to),
          targetEnd: other.slice(target.from, target.to),
        }),
        expected: {
          "main.txt": kind === 8 ? main : splice(main, from.from, from.to, ""),
          "other.txt": splice(other, to.from, to.to, moved),
        },
      };
    }
    case 10: {
      // Write saves exactly the content.
      const content = bombFile(rng);
      return {
        name: `write content ${JSON.stringify(content.slice(0, 20))}`,
        run: call(writeMutationTool, { path: "main.txt", content }),
        expected: { "main.txt": content },
      };
    }
    case 11: {
      // A literal whose line breaks or BOM differ from the file matches as in Pi's edit, unless
      // the normalized file holds it more than once.
      const span = uniqueSpan(rng, main, near);
      if (span === undefined) return undefined;
      const selected = main.slice(span.from, span.to);
      const variant = selected.startsWith(BOM)
        ? selected.slice(1)
        : selected.includes("\r\n")
          ? selected.replaceAll("\r\n", "\n")
          : selected.includes("\n")
            ? selected.replaceAll("\n", "\r\n")
            : selected.includes("\r")
              ? selected.replaceAll("\r", "\n")
              : undefined;
      if (variant === undefined || variant.length === 0 || main.includes(variant)) return undefined;
      const bom = main.startsWith(BOM) ? 1 : 0;
      const body = main.slice(bom);
      const query = pi.normalizeToLF(variant.startsWith(BOM) ? variant.slice(1) : variant);
      const found = starts(pi.normalizeToLF(body), query);
      if (query.length === 0 || found.length === 0) return undefined;
      const at = found[0] ?? 0;
      const from = bom + sourceOffset(body, at);
      const to = bom + sourceOffset(body, at + query.length);
      return {
        name: `replace normalized ${JSON.stringify(variant)}`,
        run: call(replaceMutationTool, { path: "main.txt", start: variant, newText: text }),
        expected:
          found.length === 1
            ? { "main.txt": splice(main, from, to, sentText(main, from, text)) }
            : undefined,
      };
    }
    case 12: {
      // An ambiguous literal is refused.
      const repeated = [...new Set(PIECES)].find((value) => occurrences(main, value) > 1);
      if (repeated === undefined) return undefined;
      return {
        name: `refuse ambiguous ${JSON.stringify(repeated)}`,
        run: call(replaceMutationTool, { path: "main.txt", start: repeated, newText: "BAD" }),
        expected: undefined,
      };
    }
    case 14: {
      // A literal with plain spaces or a composed character instead of the file's matches
      // fuzzily, as in Pi's edit, and replaces only the characters it matched.
      const span = uniqueSpan(rng, main, near);
      if (span === undefined) return undefined;
      const selected = main.slice(span.from, span.to);
      const variant = selected
        .replaceAll("\u00A0", " ")
        .replaceAll("\u202F", " ")
        .replaceAll("e\u0301", "\u00E9");
      const firstLine = selected.split("\n")[0] ?? "";
      if (
        variant === selected ||
        main.includes(variant) ||
        /[\r\uFEFF]/u.test(selected) ||
        selected.trim() === "" ||
        /\s$/u.test(selected) ||
        (firstLine !== selected && firstLine !== "" && firstLine.trim() === "") ||
        /^\p{M}/u.test(selected) ||
        /^\p{M}/u.test(main.slice(span.to))
      )
        return undefined;
      const body = pi.normalizeToLF(main.startsWith(BOM) ? main.slice(1) : main);
      if (starts(body, pi.normalizeToLF(variant)).length > 0) return undefined;
      const found = starts(
        pi.normalizeForFuzzyMatch(body),
        pi.normalizeForFuzzyMatch(pi.normalizeToLF(variant)),
      );
      if (found.length === 0) return undefined;
      const { from, to } = literalSpan(main, span);
      return {
        name: `replace fuzzy ${JSON.stringify(variant)}`,
        run: call(replaceMutationTool, { path: "main.txt", start: variant, text }),
        expected:
          found.length === 1
            ? { "main.txt": splice(main, from, to, sentText(main, from, text)) }
            : undefined,
      };
    }
    default: {
      // Insert after a whole line with text ending in LF adds exactly the text.
      const line = uniqueLine();
      if (line === undefined || !main.slice(0, lines[line]?.to).endsWith("\n")) return undefined;
      const insert = `${text}\n`;
      const at = lines[line]?.to ?? 0;
      return {
        name: `insert after line ${String(line + 1)}`,
        run: call(insertMutationTool, { path: "main.txt", anchor: anchors[line], newText: insert }),
        expected: { "main.txt": splice(main, at, at, insert) },
      };
    }
  }
}

/**
 * A replace whose text equals the selected bytes changes nothing, so the tool refuses it. The
 * reference model predicts that case as a no-op result.
 */
function refuseIdenticalReplace(
  operation: Operation | undefined,
  main: string,
  other: string,
): Operation | undefined {
  if (operation === undefined || !operation.name.startsWith("replace ")) return operation;
  const { expected } = operation;
  if (expected === undefined) return operation;
  const unchanged =
    (expected["main.txt"] ?? main) === main && (expected["other.txt"] ?? other) === other;
  return unchanged ? { ...operation, expected: undefined } : operation;
}

/** The kinds of operation the seeds ran, so a generator change cannot silently drop one. */
const covered = new Set<string>();
/** The kinds of operation that applied an edit at least once. */
const appliedKinds = new Set<string>();

describe("byte-exact edits on bomb files", () => {
  test.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "every edit equals the reference model (seed %i)",
    async (seed) => {
      const rng = random(seed * 7919);
      const h = await harness();
      let main = bombFile(rng);
      let other = `${BOM}slot one\r\nslot two\nlast\rslot`;
      await put("main.txt", main);
      await put("other.txt", other);
      let near: number | undefined;
      let applied = 0;
      for (let step = 0; step < 40; step += 1) {
        const operation = refuseIdenticalReplace(
          randomOperation(rng, h, main, other, near),
          main,
          other,
        );
        if (operation === undefined) continue;
        const label = `seed ${String(seed)} step ${String(step)}: ${operation.name} on ${JSON.stringify(main)}`;
        const outcome = await operation.run();
        covered.add(operation.name.split(" ").slice(0, 2).join(" "));
        const mainNow = (await bytes("main.txt")).toString("utf8");
        const otherNow = (await bytes("other.txt")).toString("utf8");
        if (operation.expected === undefined) {
          expect(outcome.applied, label).toBe(false);
          expect(mainNow, label).toBe(main);
          expect(otherNow, label).toBe(other);
          continue;
        }
        expect(outcome.applied, `${label}\n${outcome.text}`).toBe(true);
        const expectedMain = operation.expected["main.txt"] ?? main;
        const expectedOther = operation.expected["other.txt"] ?? other;
        expect(Buffer.compare(await bytes("main.txt"), Buffer.from(expectedMain)), label).toBe(0);
        expect(Buffer.compare(await bytes("other.txt"), Buffer.from(expectedOther)), label).toBe(0);
        // A transfer shows both files; the single-file view is checked for the other edits.
        if (expectedMain !== main && expectedOther === other)
          expectExactView(outcome.text, expectedMain);
        near = firstDifference(main, expectedMain);
        main = expectedMain;
        other = expectedOther;
        applied += 1;
        appliedKinds.add(operation.name.split(" ").slice(0, 2).join(" "));
      }
      expect(applied).toBeGreaterThan(5);
    },
    30_000,
  );

  test("the seeds cover every selector form and operation", () => {
    expect([...appliedKinds]).toEqual(
      expect.arrayContaining(["replace normalized", "replace fuzzy", "replace literal"]),
    );
    expect([...covered].sort()).toEqual(
      [
        "copy literal",
        "delete literal",
        "delete lines",
        "insert after",
        "insert before",
        "move literal",
        "refuse ambiguous",
        "replace fuzzy",
        "replace normalized",
        "replace line",
        "replace lines",
        "replace literal",
        "replace match",
        "write content",
      ].sort(),
    );
  });
});

function firstDifference(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

describe("byte-exact regressions", () => {
  test("a replace keeps the BOM of the file", async () => {
    const h = await harness();
    await put("main.txt", `${BOM}const a = 1;\r\nexport const b = 2;`);
    await h.run(replaceMutationTool, { path: "main.txt", start: "1", newText: "3" });
    expect((await bytes("main.txt")).toString("utf8")).toBe(
      `${BOM}const a = 3;\r\nexport const b = 2;`,
    );
  });

  test("a line replaced with LF-ended text keeps the LF it was sent", async () => {
    const h = await harness();
    const content = "one\r\ntwo\nthree\r\n";
    await put("main.txt", content);
    const anchor = textLineAnchors(file("main.txt"), content)[1];
    await h.run(replaceMutationTool, { path: "main.txt", start: anchor, newText: "TWO\n" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("one\r\nTWO\nthree\r\n");
  });

  test("a line replaced without a line break joins the next line, as sent", async () => {
    const h = await harness();
    const content = "one\ntwo\nthree\n";
    await put("main.txt", content);
    const anchor = textLineAnchors(file("main.txt"), content)[1];
    await h.run(replaceMutationTool, { path: "main.txt", start: anchor, newText: "TWO" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("one\nTWOthree\n");
  });

  test("a literal in a file with lone CRs is replaced exactly", async () => {
    const h = await harness();
    const content = "a\rb\rc\nd\re\nlast line\r";
    await put("main.txt", content);
    const { result, text } = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "d\re\nlast",
      newText: "X",
    });
    expect(result.isError, text).not.toBe(true);
    expect((await bytes("main.txt")).toString("utf8")).toBe("a\rb\rc\nX line\r");
  });

  test("a lone CR does not start a line for line anchors", async () => {
    const content = "a\rb\rc\nd\re\n";
    expect(textLineAnchors(file("main.txt"), content)).toHaveLength(2);
    const h = await harness();
    await put("main.txt", content);
    const anchor = textLineAnchors(file("main.txt"), content)[1];
    await h.run(deleteMutationTool, { path: "main.txt", start: anchor });
    expect((await bytes("main.txt")).toString("utf8")).toBe("a\rb\rc\n");
  });

  test("line breaks sent for a literal take the line ending of the line where they land", async () => {
    const h = await harness();
    await put("main.txt", "one\r\ntwo\r\nlf\n");
    await h.run(replaceMutationTool, { path: "main.txt", start: "one", newText: "1\n1\r\n1" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("1\r\n1\r\n1\r\ntwo\r\nlf\n");
    await h.run(insertMutationTool, { path: "main.txt", anchor: "two", newText: "\nmore" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("1\r\n1\r\n1\r\ntwo\r\nmore\r\nlf\n");
    await h.run(replaceMutationTool, { path: "main.txt", start: "lf", newText: "l\r\nf" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("1\r\n1\r\n1\r\ntwo\r\nmore\r\nl\nf\n");
  });

  test("an LF selector matches CRLF text and keeps the file's line endings", async () => {
    const h = await harness();
    await put("main.txt", "zero\none\r\ntwo\r\nthree\n");
    const { result, text } = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "one\ntwo",
      newText: "1\n2",
    });
    expect(result.isError, text).not.toBe(true);
    expect((await bytes("main.txt")).toString("utf8")).toBe("zero\n1\r\n2\r\nthree\n");
  });

  test("a literal without the BOM selects text after it and keeps the BOM", async () => {
    const h = await harness();
    await put("main.txt", `${BOM}// first\r\nsecond\n`);
    await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "// first\nsecond",
      text: "/* first */\nsecond",
    });
    expect((await bytes("main.txt")).toString("utf8")).toBe(`${BOM}/* first */\r\nsecond\n`);
  });

  test("a literal never splits a CRLF", async () => {
    const h = await harness();
    await put("main.txt", "a\r\nb");
    await h.run(insertMutationTool, { path: "main.txt", anchor: "a\r", newText: "|" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("a\r\n|b");
    await h.run(replaceMutationTool, { path: "main.txt", start: "\n|b", newText: "\nb" });
    expect((await bytes("main.txt")).toString("utf8")).toBe("a\r\nb");
  });

  test("the result view shows a missing final line break", async () => {
    const h = await harness();
    await put("main.txt", "one\ntwo");
    const { text } = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "two",
      newText: "2",
    });
    expect(shownFinalLines(text).get(3)).toBe("\\ No newline at end of file");
    const ended = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "2",
      newText: "2\n",
    });
    expect([...shownFinalLines(ended.text).values()]).toEqual(["one", "2"]);
  });

  test("the result view shows CR as part of a line", async () => {
    const h = await harness();
    await put("main.txt", "one\r\ntwo\rx\n");
    const { text } = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "one",
      newText: "1",
    });
    expect([...shownFinalLines(text).values()]).toEqual(["1\r", "two\rx"]);
  });

  test("a fuzzy literal replaces only the characters it matched", async () => {
    const h = await harness();
    const line = `  { id: "checkout-30",\u00A0feature: "legacy\u200BCheckout", retries: 3\u202F},`;
    await put("main.txt", `${line}  \r\nnext\n`);
    const { result, text } = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "retries: 3 },",
      text: "retries: 5 },",
    });
    expect(result.isError, text).not.toBe(true);
    expect((await bytes("main.txt")).toString("utf8")).toBe(
      `${line.replace("retries: 3\u202F},", "retries: 5 },")}  \r\nnext\n`,
    );
  });

  test("a literal that matches fuzzily twice is refused", async () => {
    const h = await harness();
    const content = "a\u00A0b\na\u202Fb\n";
    await put("main.txt", content);
    const { result } = await h.run(replaceMutationTool, {
      path: "main.txt",
      start: "a b",
      newText: "X",
    });
    expect(result.details.effect).toBe("not-applied");
    expect((await bytes("main.txt")).toString("utf8")).toBe(content);
  });

  describe("a replacement identical to the selected text", () => {
    /** The refusal code of a result that applied nothing and left every byte alone. */
    async function expectRefused(
      result: { isError?: boolean; details: unknown },
      content: string,
    ): Promise<void> {
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        effect: "not-applied",
        results: [{ data: { errors: [{ code: "REPLACEMENT_IDENTICAL" }] } }],
      });
      expect((await bytes("main.txt")).toString("utf8")).toBe(content);
    }

    test("a single selector refuses text equal to its characters", async () => {
      const h = await harness();
      const content = "  { id: 1,\u00a0retries: 3 },\r\nnext\r\n";
      await put("main.txt", content);
      const { result } = await h.run(replaceMutationTool, {
        path: "main.txt",
        start: "  { id: 1,\u00a0retries: 3 },",
        newText: "  { id: 1,\u00a0retries: 3 },",
      });
      await expectRefused(result, content);
    });

    test("a single selector still replaces text that differs by one byte", async () => {
      const h = await harness();
      const content = "  { id: 1, retries: 3 },\r\nnext\r\n";
      await put("main.txt", content);
      const { result } = await h.run(replaceMutationTool, {
        path: "main.txt",
        start: "  { id: 1, retries: 3 },",
        newText: "  { id: 1, retries: 3 }",
      });
      expect(result.isError).not.toBe(true);
      expect((await bytes("main.txt")).toString("utf8")).toBe(
        "  { id: 1, retries: 3 }\r\nnext\r\n",
      );
    });

    test("a start-to-end range refuses text equal to the whole span", async () => {
      const h = await harness();
      const content = "head\nalpha\nbeta\ngamma\ntail\n";
      await put("main.txt", content);
      const { result } = await h.run(replaceMutationTool, {
        path: "main.txt",
        start: "alpha",
        end: "gamma",
        newText: "alpha\nbeta\ngamma",
      });
      await expectRefused(result, content);
    });

    test("a line anchor refuses its own line with the line break", async () => {
      const h = await harness();
      const content = "one\r\ntwo\r\nthree\r\n";
      await put("main.txt", content);
      const anchor = textLineAnchors(file("main.txt"), content)[1];
      const { result } = await h.run(replaceMutationTool, {
        path: "main.txt",
        start: anchor,
        newText: "two\r\n",
      });
      await expectRefused(result, content);
    });

    test("a selection refuses when every target already equals the text", async () => {
      const h = await harness();
      const content = "beta alpha beta\n";
      await put("main.txt", content);
      const reference = h.select(file("main.txt"), content, [
        { start: position(content, 0), end: position(content, 4) },
        { start: position(content, 11), end: position(content, 15) },
      ]);
      const { result } = await h.run(replaceMutationTool, {
        path: "main.txt",
        start: reference,
        newText: "beta",
      });
      await expectRefused(result, content);
    });

    test("a selection edits its targets when only some already equal the text", async () => {
      const h = await harness();
      const content = "beta alpha beta\n";
      await put("main.txt", content);
      const reference = h.select(file("main.txt"), content, [
        { start: position(content, 0), end: position(content, 4) },
        { start: position(content, 5), end: position(content, 10) },
      ]);
      const { result, text } = await h.run(replaceMutationTool, {
        path: "main.txt",
        start: reference,
        newText: "beta",
      });
      expect(result.isError, text).not.toBe(true);
      expect((await bytes("main.txt")).toString("utf8")).toBe("beta beta beta\n");
    });
  });
});
