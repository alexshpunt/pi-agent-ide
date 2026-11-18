import type { SourceViewBlock } from "pi-agent-ide/api/code-view";

export const OUTLINE_PAGE_ROWS = 100;
const MAX_PROJECTED_BYTES = 12 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_LINES = 100_000;

export interface OutlinePage {
  readonly offset?: number;
  readonly limit?: number;
}

export function validateOutlineSnapshot(lines: readonly string[], path: string): void {
  function tooLarge(limit: string): never {
    const input = JSON.stringify({ path, offset: 1, limit: 100 });
    throw new Error(
      `File exceeds the ${limit} outline input limit. Outline paging limits output, not parsing. ` +
        `Use search on ${JSON.stringify(path)} to find declarations or call read with ${input} to inspect source lines.`,
    );
  }

  if (lines.length > MAX_SOURCE_LINES) tooLarge("100,000-line");
  let bytes = Math.max(0, lines.length - 1);
  for (const line of lines) {
    if (line.includes("\0")) throw new Error("Binary resources cannot be read as AST outlines.");
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_SOURCE_BYTES) tooLarge("4 MiB");
  }
}

/** Page the projected rows, keeping the exact original mapping on every returned source row. */
export function pageOutline(
  block: SourceViewBlock,
  path: string,
  page: OutlinePage,
): SourceViewBlock {
  const { offset = 1, limit = OUTLINE_PAGE_ROWS } = page;
  // Comments removed from the projection can leave hundreds of unmapped blank rows.
  // Preserve the original presentation for an empty source, not an entire blank page.
  const all =
    block.renderedLines.length <= 1
      ? block.renderedLines
      : block.renderedLines.filter((row) => row.sourceLine !== undefined || row.text.trim() !== "");
  if (offset > Math.max(1, all.length))
    throw new Error(
      `Outline offset ${offset} is beyond the ${all.length} projected rows. Retry with offset: 1; outline offsets are not source line numbers.`,
    );

  const rows: (typeof all)[number][] = [];
  let cursor = offset - 1;
  let bytes = 0;
  let firstSourceLine: number | undefined;
  let lastSourceLine: number | undefined;
  for (; cursor < all.length && rows.length < limit; cursor++) {
    const row = all[cursor];
    if (row === undefined) break;
    const sourceLine = row.sourceLine?.lineNumber;
    const size = Buffer.byteLength(row.text) + 1;
    const displayed =
      size <= MAX_PROJECTED_BYTES
        ? row
        : {
            text:
              sourceLine === undefined
                ? `[Outline row ${cursor + 1} exceeds the page byte limit and was omitted.]`
                : `[Outline row ${cursor + 1} (source line ${sourceLine}) exceeds the page byte limit and was omitted. Use read to inspect the source.]`,
          };
    bytes += displayed === row ? size : Buffer.byteLength(displayed.text) + 1;
    if (bytes > MAX_PROJECTED_BYTES) break;
    rows.push(displayed);
    if (displayed === row && sourceLine !== undefined) {
      firstSourceLine ??= sourceLine;
      lastSourceLine = sourceLine;
    }
  }
  if (
    offset === 1 &&
    cursor === block.renderedLines.length &&
    rows.every((row, index) => row === block.renderedLines[index])
  )
    return block;
  if (all.length === 0) return { ...block, renderedLines: [] };

  const next = cursor < all.length ? cursor + 1 : undefined;
  const window = `Outline rows ${offset}-${cursor} of ${all.length}.`;
  return {
    ...block,
    startLine: firstSourceLine ?? 0,
    endLine: lastSourceLine ?? 0,
    renderedLines: rows,
    warning:
      next === undefined
        ? window
        : `${window} Continue with outline(${JSON.stringify({ path, offset: next, limit })}).`,
  };
}
