import path from "node:path";
import { SourceText } from "#src/source-text.js";
import {
  publicRange,
  retainRegion,
  SelectionError,
  type SelectedRegion,
} from "#src/selection-region.js";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { parseDocument } from "./manager.js";
import { listElementExtent } from "./element-extent.js";
import {
  constructChildren,
  constructIndex,
  constructParent,
  constructPart,
  type ConstructNode,
} from "./constructs.js";
import type { StructuralSelectOperation } from "#src/select-schema.js";

const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

function exactNode(nodes: readonly ConstructNode[], start: number, end: number): ConstructNode {
  const matches = nodes.filter((n) => n.node.startIndex === start && n.node.endIndex === end);
  const node = matches.find((n) => n.object) ?? matches.at(-1);
  if (!node)
    throw new SelectionError(
      "EXACT_NODE_REQUIRED",
      "Navigation and parts require an exact syntax node. Use object/enclosing first for a partial match; use a returned part target to navigate its contents.",
    );
  return node;
}
function enclosing(
  nodes: readonly ConstructNode[],
  start: number,
  end: number,
  operation: Extract<StructuralSelectOperation, { kind: "object" }>,
): ConstructNode | undefined {
  let owner: ConstructNode | undefined;
  for (const candidate of nodes) {
    if (
      candidate.object !== operation.object ||
      candidate.node.startIndex > start ||
      candidate.node.endIndex < end ||
      (start === end && candidate.node.endIndex === end)
    )
      continue;
    if (
      !owner ||
      candidate.node.endIndex - candidate.node.startIndex <
        owner.node.endIndex - owner.node.startIndex
    )
      owner = candidate;
  }
  if (
    !owner &&
    nodes.filter(
      (n) => n.object === operation.object && n.node.startIndex < end && n.node.endIndex > start,
    ).length > 1
  )
    throw new SelectionError(
      "AMBIGUOUS_SEED",
      "The seed spans separate constructs; select narrower input ranges.",
    );
  let level = 1;
  while (owner && level < (operation.level ?? 1)) {
    owner = constructParent(owner);
    while (owner && owner.object !== operation.object) owner = constructParent(owner);
    level++;
  }
  return owner;
}
function navigate(
  input: ConstructNode,
  operation: Extract<StructuralSelectOperation, { kind: "navigate" }>,
  root: ConstructNode,
  signal?: AbortSignal,
): ConstructNode[] {
  let outputs: ConstructNode[];
  switch (operation.relation) {
    case "parent": {
      const parent = constructParent(input);
      outputs = parent ? [parent] : [];
      break;
    }
    case "ancestors": {
      outputs = [];
      let parent = constructParent(input);
      while (parent) {
        signal?.throwIfAborted();
        outputs.push(parent);
        parent = constructParent(parent);
      }
      break;
    }
    case "children":
    case "descendants": {
      outputs = constructChildren(input, operation.relation === "descendants", signal);
      break;
    }
    case "siblings": {
      if (!input.object)
        throw new SelectionError(
          "EXACT_CONSTRUCT_REQUIRED",
          "siblings requires an exact supported construct, not a part container. Use enclosing first.",
        );
      const siblings = constructChildren(constructParent(input) ?? root, false, signal);
      const index = siblings.indexOf(input);
      const direction = operation.direction ?? "all";
      const sibling = direction === "previous" ? siblings[index - 1] : siblings[index + 1];
      outputs =
        direction === "all" ? siblings.filter((n) => n !== input) : sibling ? [sibling] : [];
      break;
    }
  }
  return outputs
    .filter((n) => !operation.object || n.object === operation.object)
    .sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);
}

/** Derive JS/TS constructs, parts and list-element extents from verified bytes using the existing syntax provider. */
export async function selectStructuralRegions(
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
        "Select AST supports JavaScript and TypeScript files, without JSX/TSX.",
      );
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
      const nodes = constructIndex(tree.rootNode, signal);
      const root = nodes[0];
      if (!root) throw Error("Missing syntax root");
      const source = new SourceText(target.expectedContent);
      for (const seed of target.ranges) {
        signal?.throwIfAborted();
        const start = source.offset(seed.start),
          end = source.offset(seed.end);
        const owner =
          operation.kind === "object"
            ? enclosing(nodes, start, end, operation)
            : exactNode(nodes, start, end);
        const element =
          owner && operation.kind === "elementExtent"
            ? listElementExtent(owner, operation.extent, target.expectedContent)
            : undefined;
        const outputs = owner
          ? operation.kind === "part"
            ? [constructPart(owner, operation.part)]
                .filter((n) => n !== undefined)
                .map((node) => ({ node, object: owner.object }))
            : operation.kind === "navigate"
              ? navigate(owner, operation, root, signal)
              : [owner]
          : [];
        if (!outputs.length) missingInputs++;
        for (const output of outputs) {
          const node = element ?? output.node;
          const syntax =
            output.object && operation.kind !== "elementExtent"
              ? {
                  object: output.object,
                  ...(operation.kind === "part" ? { part: operation.part } : {}),
                }
              : undefined;
          retainRegion(selected, {
            target,
            range: { start: source.position(node.startIndex), end: source.position(node.endIndex) },
            text: target.expectedContent.slice(node.startIndex, node.endIndex),
            origins: [
              {
                source: target.source,
                range: publicRange({ start: seed.start, end: source.position(end) }),
                expanded: node.startIndex < start || node.endIndex > end,
              },
            ],
            ...(syntax ? { syntax } : {}),
          });
        }
      }
    } finally {
      tree.delete?.();
    }
  }
  return { regions: [...selected.values()], missingInputs };
}
