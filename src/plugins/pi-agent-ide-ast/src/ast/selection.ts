import path from "node:path";
import { createTextDocument } from "pi-agent-text";
import type { ResultRange, ResultSourceTarget, ResolvedResultTargets } from "pi-agent-resource";
import { parseDocument } from "./manager.js";
import type { SyntaxNode } from "./syntax-tree.js";
import type { SelectOperation, SelectionItem } from "#src/select-schema.js";

const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const functions = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
  "function_signature",
  "method_signature",
  "abstract_method_signature",
]);

/** A structural refusal is different from a valid seed with no enclosing function or body. */
export class SelectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Trusted output geometry and original seed associations, before handles and previews are added. */
export interface SelectedRegion {
  readonly target: ResultSourceTarget;
  readonly range: ResultRange;
  readonly text: string;
  readonly origins: SelectionItem["origins"];
}

/** Derive function boundaries from verified bytes without changing or concatenating source ranges. */
export async function selectFunctionRegions(
  input: ResolvedResultTargets,
  operation: SelectOperation,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ readonly regions: readonly SelectedRegion[]; readonly missingInputs: number }> {
  const selected = new Map<string, SelectedRegion>();
  let missingInputs = 0;
  for (const target of input.targets) {
    signal?.throwIfAborted();
    if (!extensions.has(path.extname(target.source).toLowerCase()))
      throw new SelectionError(
        "UNSUPPORTED_LANGUAGE",
        "Select function/body supports JavaScript and TypeScript files, without JSX/TSX.",
      );
    // Keep CR characters: join reconstructs exactly the original bytes, not a normalized document.
    const tree = await parseDocument(target.source, cwd, target.expectedContent.split("\n"));
    if (!tree)
      throw new SelectionError(
        "UNSUPPORTED_PROVIDER",
        "No syntax provider is available for this source.",
      );
    try {
      if (tree.rootNode.hasError)
        throw new SelectionError(
          "INVALID_SYNTAX",
          "The syntax provider reports errors; no structural targets were created.",
        );
      const nodes: SyntaxNode[] = [];
      const pending = [tree.rootNode];
      while (pending.length > 0) {
        signal?.throwIfAborted();
        const node = pending.pop();
        if (!node) continue;
        if (functions.has(node.type)) nodes.push(node);
        pending.push(...node.namedChildren);
      }
      const lines = sourceLines(target.expectedContent);
      for (const seed of target.ranges) {
        signal?.throwIfAborted();
        const start = positionOffset(lines, seed.start);
        const end = positionOffset(lines, seed.end);
        let owner: SyntaxNode | undefined;
        if (operation.kind === "part") {
          owner = nodes.find((node) => node.startIndex === start && node.endIndex === end);
          if (!owner)
            throw new SelectionError(
              "UNSUPPORTED_PART_INPUT",
              "part/body requires an exact supported function target.",
            );
        } else {
          for (const node of nodes) {
            if (node.startIndex > start || node.endIndex < end) continue;
            if (!owner || node.endIndex - node.startIndex < owner.endIndex - owner.startIndex)
              owner = node;
          }
          if (
            !owner &&
            nodes.filter((node) => node.startIndex < end && node.endIndex > start).length > 1
          )
            throw new SelectionError(
              "AMBIGUOUS_SEED",
              "The seed spans separate functions; select narrower input ranges.",
            );
        }
        const output = operation.kind === "part" ? owner?.childForFieldName("body") : owner;
        if (!output) {
          missingInputs++;
          continue;
        }
        const range: ResultRange = {
          start: offsetPosition(lines, output.startIndex),
          end: offsetPosition(lines, output.endIndex),
        };
        const identity = JSON.stringify([target.source, range]);
        const origin = {
          source: target.source,
          range: publicRange({ start: seed.start, end: offsetPosition(lines, end) }),
          expanded: output.startIndex < start || output.endIndex > end,
        };
        const previous = selected.get(identity);
        selected.set(identity, {
          target,
          range,
          text: target.expectedContent.slice(output.startIndex, output.endIndex),
          origins: previous ? [...previous.origins, origin] : [origin],
        });
      }
    } finally {
      tree.delete?.();
    }
  }
  return { regions: [...selected.values()], missingInputs };
}

interface SourceLine {
  readonly start: number;
  readonly length: number;
}

function sourceLines(source: string): SourceLine[] {
  let start = 0;
  const document = createTextDocument("", source);
  const lines = document.lines.map((line) => {
    const result = { start, length: line.content.length };
    start += line.content.length + line.lineEnding.length;
    return result;
  });
  if (lines.length === 0 || document.lines.at(-1)?.lineEnding) lines.push({ start, length: 0 });
  return lines;
}

function positionOffset(lines: readonly SourceLine[], position: ResultRange["start"]): number {
  const line = lines[position.lineNumber - 1];
  if (!line || position.column < 0 || position.column > line.length)
    throw new SelectionError(
      "INVALID_RANGE",
      "Source coordinates are outside the retained snapshot.",
    );
  return line.start + position.column;
}

function offsetPosition(lines: readonly SourceLine[], offset: number): ResultRange["start"] {
  let index = lines.length - 1;
  while (index > 0 && (lines[index]?.start ?? 0) > offset) index--;
  return { lineNumber: index + 1, column: offset - (lines[index]?.start ?? 0) };
}

/** Public coordinates use one-based lines and exclusive UTF-16 character ends. */
export function publicRange(range: ResultRange): SelectionItem["range"] {
  return {
    startLine: range.start.lineNumber,
    startColumn: range.start.column,
    endLine: range.end.lineNumber,
    endColumn: range.end.column,
  };
}
