import type { AstObject, AstPart } from "#src/select-schema.js";
import { SelectionError } from "#src/selection-region.js";
import type { SyntaxNode } from "./syntax-tree.js";

const categories: Readonly<Record<string, AstObject>> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_expression: "function",
  generator_function: "function",
  arrow_function: "function",
  method_definition: "function",
  function_signature: "function",
  method_signature: "function",
  abstract_method_signature: "function",
  call_expression: "call",
  new_expression: "call",
  class_declaration: "class",
  class: "class",
  abstract_class_declaration: "class",
  if_statement: "if",
  switch_statement: "switch",
  for_statement: "loop",
  for_in_statement: "loop",
  while_statement: "loop",
  do_statement: "loop",
  try_statement: "try",
  catch_clause: "catch",
  variable_declarator: "binding",
  assignment_expression: "assignment",
  augmented_assignment_expression: "assignment",
  object: "object",
  object_pattern: "object",
  pair: "property",
  pair_pattern: "property",
  shorthand_property_identifier: "property",
  shorthand_property_identifier_pattern: "property",
  array: "array",
  array_pattern: "array",
  return_statement: "return",
  throw_statement: "throw",
};

/** One document-local syntax node with stable parent identity, not a persistent second tree store. */
export interface ConstructNode {
  readonly node: SyntaxNode;
  readonly object: AstObject | undefined;
  readonly parent: ConstructNode | undefined;
  readonly children: ConstructNode[];
}

/** Index existing named syntax nodes once; do not expose parser-only wrapper names to callers. */
export function constructIndex(root: SyntaxNode, signal?: AbortSignal): ConstructNode[] {
  const nodes: ConstructNode[] = [];
  const pending: Array<{ node: SyntaxNode; parent: ConstructNode | undefined }> = [
    { node: root, parent: undefined },
  ];
  while (pending.length) {
    signal?.throwIfAborted();
    const current = pending.pop();
    if (!current) continue;
    const indexed: ConstructNode = {
      node: current.node,
      object: categories[current.node.type],
      parent: current.parent,
      children: [],
    };
    current.parent?.children.push(indexed);
    nodes.push(indexed);
    for (const node of current.node.namedChildren.toReversed())
      pending.push({ node, parent: indexed });
  }
  return nodes;
}

/** Find the nearest recognized parent without changing topology for a category filter. */
export function constructParent(input: ConstructNode): ConstructNode | undefined {
  let parent = input.parent;
  while (parent && !parent.object) parent = parent.parent;
  return parent;
}

/** Return direct construct children or all descendants, skipping syntax-only wrappers. */
export function constructChildren(
  input: ConstructNode,
  all: boolean,
  signal?: AbortSignal,
): ConstructNode[] {
  const nodes: ConstructNode[] = [];
  const pending = [...input.children].reverse();
  while (pending.length) {
    signal?.throwIfAborted();
    const node = pending.pop();
    if (!node) continue;
    if (node.object) nodes.push(node);
    if (all || !node.object) pending.push(...node.children.toReversed());
  }
  return nodes;
}

type PartFields = readonly (readonly [AstPart, readonly string[]])[];
const parts: Readonly<Record<AstObject, PartFields>> = {
  function: [
    ["name", ["name"]],
    ["body", ["body"]],
    ["parameters", ["parameters", "parameter"]],
    ["returnType", ["return_type"]],
  ],
  call: [
    ["callee", ["function", "constructor"]],
    ["arguments", ["arguments"]],
  ],
  class: [
    ["name", ["name"]],
    ["body", ["body"]],
  ],
  if: [
    ["condition", ["condition"]],
    ["then", ["consequence"]],
    ["else", ["alternative"]],
  ],
  switch: [
    ["condition", ["value"]],
    ["body", ["body"]],
  ],
  loop: [
    ["condition", ["condition"]],
    ["body", ["body"]],
  ],
  try: [
    ["body", ["body"]],
    ["handler", ["handler"]],
    ["finalizer", ["finalizer"]],
  ],
  catch: [
    ["body", ["body"]],
    ["parameter", ["parameter"]],
  ],
  binding: [
    ["name", ["name"]],
    ["type", ["type"]],
    ["value", ["value"]],
  ],
  assignment: [
    ["left", ["left"]],
    ["right", ["right"]],
  ],
  property: [
    ["key", ["key"]],
    ["value", ["value"]],
  ],
  return: [["value", []]],
  throw: [["value", []]],
  object: [],
  array: [],
};
/** Publish only parts that have an explicit meaning for this construct form. */
function partFields(input: ConstructNode): PartFields {
  if (input.node.type === "for_statement")
    return [
      ["initializer", ["initializer"]],
      ["condition", ["condition"]],
      ["update", ["increment"]],
      ["body", ["body"]],
    ];
  if (input.node.type === "for_in_statement")
    return [
      ["left", ["left"]],
      ["iterable", ["right"]],
      ["body", ["body"]],
    ];
  if (input.node.type === "finally_clause") return [["body", ["body"]]];
  return input.object ? parts[input.object] : [];
}

/** Select provider-derived parts exactly; optional absence is different from an unsupported request. */
export function constructPart(input: ConstructNode, part: AstPart): SyntaxNode | undefined {
  const available = partFields(input);
  const fields = available.find(([name]) => name === part)?.[1];
  if (!fields)
    throw new SelectionError(
      "UNSUPPORTED_PART",
      `Unsupported part ${part} for ${input.object ?? "this syntax container"}; supported parts: ${available.map(([name]) => name).join(", ") || "none"}. Use navigate children/descendants for nested constructs.`,
    );
  if (input.object === "property" && input.node.type.startsWith("shorthand_property_identifier"))
    return input.node;
  if (input.object === "return" || input.object === "throw")
    return input.node.namedChildren.find((node) => node.type !== "comment");
  for (const field of fields) {
    const node = input.node.childForFieldName(field);
    if (node) return node;
  }
  return undefined;
}
