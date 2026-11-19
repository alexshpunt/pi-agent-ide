import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FILE_TEXT_READ_EVENT,
  FILE_TEXT_VISIBLE_EVENT,
  createLineMap,
  type FileTextVisible,
  fileTextDigest,
  fileTextKeys,
  takeFileTextWindows,
  type FileTextRead,
} from "pi-agent-resource";
import type { TextEditCompletion } from "#src/api/edit-completion.ts";
import { TextMutationInputError } from "#src/api/mutation-tool.ts";
import { TextChangeDocument, type TextRange } from "./text-change-engine.ts";
import type { TextResourceEditRequest } from "./text-editor-core.ts";

function isTextFile(resolvedBy: string, source: string): boolean {
  return resolvedBy === "filesystem" || source.startsWith("ssh://");
}

// Leave room for ordinary function edits with literal endpoints. Refuse when the unseen
// portion alone is large, even if most of the selected span was shown.
const unseenLineLimit = 200;
const unseenCharacterLimit = 128 * 1024;
const maxRetainedCharacters = 16 * 1024 * 1024;
const maxRetainedSnapshots = 32;

interface ObservedSnapshot {
  readonly keys: Set<string>;
  readonly document: TextChangeDocument;
  ranges: readonly TextRange[];
}

function union(ranges: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to)
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) };
    else merged.push(range);
  }
  return merged;
}

/** Keep only bytes on unchanged lines, including when a peer inserted lines before them. */
function rangesInSnapshot(
  snapshot: ObservedSnapshot,
  current: TextChangeDocument,
): readonly TextRange[] {
  if (snapshot.document.content === current.content) return snapshot.ranges;
  const map = createLineMap(snapshot.document.content, current.content);
  if (!map) return [];
  const result: TextRange[] = [];
  for (const range of snapshot.ranges) {
    for (
      let line = snapshot.document.lineNumberAt(range.from);
      line <= snapshot.document.lineNumberAt(range.to - 1);
      line++
    ) {
      const moved = map.newLine(line);
      if (moved === undefined) continue;
      const old = snapshot.document.lineRange(line, line);
      const next = current.lineRange(moved, moved);
      result.push({
        from: next.from + Math.max(0, range.from - old.from),
        to: next.from + Math.min(old.to, range.to) - old.from,
      });
    }
  }
  return result;
}

function describeBoundaries(document: TextChangeDocument, from: number, to: number): string {
  const regions: number[] = [];
  const declarations: number[] = [];
  for (let line = from; line <= to; line++) {
    const text = document.text(document.lineRange(line, line));
    if (/^\s*#\s*pragma\s+(?:end)?region\b/u.test(text)) regions.push(line);
    else if (
      /^(?:namespace|class|struct|enum|interface|typedef|def|fn|function)\b|^(?:[\w:*&<>]+ +)+[\w:]+\([^;]*\)\s*\{/u.test(
        text,
      )
    )
      declarations.push(line);
  }
  const describe = (name: string, lines: number[]) =>
    lines.length === 0
      ? []
      : [
          `${lines.length} ${name} ${lines.length === 1 ? "boundary" : "boundaries"} at lines ${lines.slice(0, 5).join(", ")}${lines.length > 5 ? ", …" : ""}`,
        ];
  const crossed = [...describe("region", regions), ...describe("declaration", declarations)];
  return crossed.length === 0 ? "" : ` Crosses ${crossed.join(" and ")}.`;
}

/** Observations belong to the session; internal planning or recovery reads cannot advance them. */
export class FileWriteObservations {
  readonly #digests = new Map<string, string>();
  readonly #visible: ObservedSnapshot[] = [];

  constructor(pi: ExtensionAPI) {
    const unsubscribe = pi.events.on(FILE_TEXT_READ_EVENT, (event) => {
      const { keys, digest, complete, visible } = event as FileTextRead;
      if (visible !== undefined) this.observe({ keys, ...visible });
      // A partial read can establish a baseline, but cannot authorize discarding unseen changes.
      for (const key of keys)
        if (complete || !this.#digests.has(key)) this.#digests.set(key, digest);
    });
    const unsubscribeVisible = pi.events.on(FILE_TEXT_VISIBLE_EVENT, (event) =>
      this.observe(event as FileTextVisible),
    );
    const clear = () => {
      this.#digests.clear();
      this.#visible.length = 0;
    };
    pi.on("session_start", clear);
    pi.on("session_shutdown", () => {
      unsubscribe();
      unsubscribeVisible();
      clear();
    });
  }

  observe({ keys, content, ranges }: FileTextVisible): void {
    if (keys.length === 0 || ranges.length === 0 || content.length > maxRetainedCharacters) return;
    const index = this.#visible.findIndex(
      (item) => item.document.content === content && keys.some((key) => item.keys.has(key)),
    );
    const snapshot = this.#visible[index] ?? {
      keys: new Set<string>(),
      document: new TextChangeDocument(content),
      ranges: [],
    };
    const shown = ranges.flatMap(({ start, end, adjusted }) => {
      if (adjusted === true) return [];
      try {
        const range = snapshot.document.range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        );
        if (range.from === range.to) return [];
        // A result showing the end of a line need not print its LF or CRLF as source text.
        const lineEnd = snapshot.document.lineRange(end.lineNumber, end.lineNumber).to;
        const tail = content.slice(range.to, Math.min(range.to + 2, lineEnd));
        const to =
          (tail === "\n" || tail === "\r\n") && range.to + tail.length === lineEnd
            ? lineEnd
            : range.to;
        return [{ from: range.from, to }];
      } catch {
        // An output using a different line convention does not establish coverage.
        return [];
      }
    });
    if (shown.length === 0) return;
    for (const key of keys) snapshot.keys.add(key);
    snapshot.ranges = union([...snapshot.ranges, ...shown]);
    if (index !== -1) this.#visible.splice(index, 1);
    this.#visible.push(snapshot);
    let budget = maxRetainedCharacters;
    for (let i = this.#visible.length - 1; i >= 0; i--) {
      budget -= this.#visible[i]?.document.length ?? 0;
      if (budget < 0 || this.#visible.length - i > maxRetainedSnapshots) {
        this.#visible.splice(0, i + 1);
        break;
      }
    }
  }

  async checkSpan(
    source: string,
    cwd: string,
    document: TextChangeDocument,
    from: number,
    to: number,
  ): Promise<void> {
    if (
      to <= from ||
      (/^[a-z][a-z\d+.-]*:\/\//iu.test(source) &&
        !source.startsWith("ssh://") &&
        !source.startsWith("file://"))
    )
      return;
    const first = document.lineNumberAt(from);
    const last = document.lineNumberAt(to - 1);
    if (last - first + 1 <= unseenLineLimit && to - from <= unseenCharacterLimit) return;

    const keys = await fileTextKeys(source, cwd);
    const matching = this.#visible.filter((snapshot) => keys.some((key) => snapshot.keys.has(key)));
    const fresh = matching.filter(({ document: seen }) => seen.content === document.content);
    const countUnseen = (covered: readonly TextRange[]) => {
      let next = from;
      let lines = 0;
      let characters = 0;
      let previous = first - 1;
      const gap = (start: number, end: number) => {
        if (start >= end) return;
        const first = document.lineNumberAt(start);
        const last = document.lineNumberAt(end - 1);
        lines += last - Math.max(previous + 1, first) + 1;
        characters += end - start;
        previous = last;
      };
      for (const range of covered) {
        if (range.to <= next) continue;
        if (range.from >= to) break;
        gap(next, range.from);
        next = range.to;
      }
      gap(next, to);
      return { lines, characters };
    };
    const small = ({ lines, characters }: ReturnType<typeof countUnseen>) =>
      lines <= unseenLineLimit && characters <= unseenCharacterLimit;
    if (small(countUnseen(union(fresh.flatMap(({ ranges }) => ranges))))) return;
    const unseen = countUnseen(
      union(matching.flatMap((snapshot) => rangesInSnapshot(snapshot, document))),
    );
    if (small(unseen)) return;
    throw new TextMutationInputError(
      "UNSEEN_EDIT_SPAN",
      `The anchors select lines ${first}–${last} (${last - first + 1} lines), including ${unseen.lines} lines with ${unseen.characters} characters this session has not seen.${describeBoundaries(document, first, last)} Use closer anchors, or Read these lines first (in pages if needed) and retry.`,
    );
  }

  matches(keys: readonly string[], digest: string | undefined): boolean {
    return keys.every((key) => !this.#digests.has(key) || this.#digests.get(key) === digest);
  }

  async presented(content: readonly { type: string }[], cwd: string): Promise<void> {
    for (const block of content) {
      for (const { source, ...shown } of takeFileTextWindows(block)) {
        if (source.includes("://") && !source.startsWith("ssh://") && !source.startsWith("file://"))
          continue;
        this.observe({ keys: await fileTextKeys(source, cwd), ...shown });
      }
    }
  }

  async saved(completion: TextEditCompletion): Promise<void> {
    if (!isTextFile(completion.resolvedBy, completion.resourceSource)) return;
    const keys = await fileTextKeys(completion.resourceSource, completion.cwd);
    const before = completion.beforePostProcessing ?? completion.before;
    const prior = completion.existed ? fileTextDigest(before.content) : undefined;
    // A targeted edit can succeed despite unseen peer changes. Don't bless that entire file.
    if (!this.matches(keys, prior)) return;
    const saved = fileTextDigest(completion.after.content);
    for (const key of keys) this.#digests.set(key, saved);
  }
}

const conflict =
  "File changed since this session read or wrote it. Read the whole current file and rebuild the content, or use a targeted edit.";

/** Pin even an unobserved file's first snapshot: a guarded-write retry cannot rebase a payload. */
export function guardWholeFileWrite(
  observations: FileWriteObservations | undefined,
  expectedContent: string | undefined,
): NonNullable<TextResourceEditRequest["checkSnapshot"]> {
  let first: { identity: string; digest: string | undefined } | undefined;
  return async ({ source, resolvedBy, existed, content }, cwd) => {
    if (expectedContent !== undefined && (!existed || expectedContent !== content)) return conflict;
    if (!isTextFile(resolvedBy, source)) return;
    const keys = await fileTextKeys(source, cwd);
    const identity = keys[0] ?? source;
    const digest = existed ? fileTextDigest(content) : undefined;
    if (first === undefined) {
      if (expectedContent === undefined && observations?.matches(keys, digest) === false)
        return conflict;
      first = { identity, digest };
    }
    return identity !== first.identity || digest !== first.digest ? conflict : undefined;
  };
}
