import path from "node:path";
import { SourceText } from "#src/source-text.js";
import {
  publicRange,
  retainRegion,
  SelectionError,
  type SelectedRegion,
} from "#src/selection-region.js";
import type { ResultRange, ResolvedResultTargets } from "pi-agent-resource";
import { parseDocument } from "./manager.js";
import type { SyntaxNode } from "./syntax-tree.js";
import type { StructuralSelectOperation } from "#src/select-schema.js";

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

/** Derive function boundaries from verified bytes without changing or concatenating source ranges. */
export async function selectFunctionRegions(
  input: ResolvedResultTargets,
  operation: StructuralSelectOperation,
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
      const source = new SourceText(target.expectedContent);
      for (const seed of target.ranges) {
        signal?.throwIfAborted();
        const start = source.offset(seed.start);
        const end = source.offset(seed.end);
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
          start: source.position(output.startIndex),
          end: source.position(output.endIndex),
        };
        const origin = {
          source: target.source,
          range: publicRange({ start: seed.start, end: source.position(end) }),
          expanded: output.startIndex < start || output.endIndex > end,
        };
        retainRegion(selected, {
          target,
          range,
          text: target.expectedContent.slice(output.startIndex, output.endIndex),
          origins: [origin],
        });
      }
    } finally {
      tree.delete?.();
    }
  }
  return { regions: [...selected.values()], missingInputs };
}
