import type { TextDocument } from "pi-agent-text";

interface IssuedLine {
  readonly from: number;
  readonly to: number;
}

interface Window {
  readonly text: Buffer;
  readonly lines: ReadonlyMap<string, IssuedLine | null>;
}

// Never evict history and then accept a later observation: a new result can print the same
// pair for different text. If history fills up, use exact text or a result reference instead.
const HISTORY_BUDGET = 32 * 1024 * 1024;
const WINDOW_COST = 128;
const LINE_COST = 128;

/** Remembers the text between pairs of hash anchors shown in the same window. */
export class LineHashRangeHistory {
  private readonly sources = new Map<string, Window[]>();
  private remaining = HISTORY_BUDGET;
  private exhausted = false;

  public record(
    source: string,
    document: TextDocument,
    anchors: readonly string[],
    shown: ReadonlySet<number> | undefined,
  ): void {
    if (this.exhausted || shown?.size === 0) return;
    const lines = new Map<string, IssuedLine | null>();
    let from = 0;
    let first: number | undefined;
    let last = 0;
    for (const [index, line] of document.lines.entries()) {
      const to = from + line.content.length + line.lineEnding.length;
      const token = anchors[index];
      if (token !== undefined && (shown === undefined || shown.has(line.lineNumber))) {
        first ??= from;
        last = to;
        lines.set(token, lines.has(token) ? null : { from: from - first, to: to - first });
      }
      from = to;
    }
    if (first === undefined) return;

    // Copy only the window's text, not the backing string for the entire source. UTF-16 offsets
    // match the editor's offsets and preserve line endings and all code units exactly.
    const text = Buffer.from(document.content.slice(first, last), "utf16le");
    const windows = this.sources.get(source) ?? [];
    if (windows.some((window) => sameWindow(window, text, lines))) return;

    const cost = text.length + lines.size * LINE_COST + source.length * 2 + WINDOW_COST;
    if (cost > this.remaining) {
      this.exhausted = true;
      this.sources.clear();
      return;
    }
    this.remaining -= cost;
    windows.push({ text, lines });
    this.sources.set(source, windows);
  }

  public check(
    source: string,
    start: string,
    end: string,
    selected: string,
  ): "unverified" | "changed" | "unchanged" {
    if (this.exhausted) return "unverified";
    let bytes: Buffer | undefined;
    for (const window of this.sources.get(source) ?? []) {
      const first = window.lines.get(start);
      const last = window.lines.get(end);
      if (first === undefined || last === undefined) continue;
      if (
        first === null ||
        last === null ||
        first.from > last.from ||
        last.to - first.from !== selected.length
      ) {
        return "changed";
      }
      bytes ??= Buffer.from(selected, "utf16le");
      if (!window.text.subarray(first.from * 2, last.to * 2).equals(bytes)) return "changed";
    }
    return bytes === undefined ? "unverified" : "unchanged";
  }
}

function sameWindow(
  window: Window,
  text: Buffer,
  lines: ReadonlyMap<string, IssuedLine | null>,
): boolean {
  if (window.lines.size !== lines.size || !window.text.equals(text)) return false;
  for (const [token, line] of lines) {
    const previous = window.lines.get(token);
    if (previous === undefined || previous?.from !== line?.from || previous?.to !== line?.to) {
      return false;
    }
  }
  return true;
}
