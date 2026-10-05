import { SelectionError } from "#src/selection-region.js";
import type { ConstructNode } from "./constructs.js";

/** Derive an exact direct argument/parameter extent; separators never come from nested expression text. */
export function listElementExtent(
  input: ConstructNode,
  extent: "inside" | "around",
  source: string,
): { readonly startIndex: number; readonly endIndex: number } {
  let element = input;
  while (
    element.parent &&
    element.parent.node.startIndex === element.node.startIndex &&
    element.parent.node.endIndex === element.node.endIndex
  )
    element = element.parent;
  const list = element.parent;
  if (
    !list ||
    !(
      (list.node.type === "arguments" && list.parent?.object === "call") ||
      (list.node.type === "formal_parameters" && list.parent?.object === "function")
    ) ||
    element.node.type === "comment"
  )
    throw new SelectionError(
      "EXACT_LIST_ELEMENT_REQUIRED",
      "elementExtent requires an exact direct call argument or parenthesized function parameter. Use a full AST capture; partial expressions and other lists are not supported.",
    );
  const open = list.node.startIndex,
    close = list.node.endIndex - 1;
  if (source[open] !== "(" || source[close] !== ")")
    throw new SelectionError(
      "UNSUPPORTED_LIST",
      "Only parenthesized argument and parameter lists are supported.",
    );
  if (extent === "inside")
    return { startIndex: element.node.startIndex, endIndex: element.node.endIndex };
  const elements = list.children.filter((n) => n.node.type !== "comment");
  const index = elements.indexOf(element);
  const previous = elements[index - 1],
    next = elements[index + 1];
  const leadingStart = previous?.node.endIndex ?? open + 1;
  const trailingEnd = next?.node.startIndex ?? close;
  const leading = source.slice(leadingStart, element.node.startIndex);
  const trailing = source.slice(element.node.endIndex, trailingEnd);
  if (
    !(previous ? /^\s*,\s*$/u : /^\s*$/u).test(leading) ||
    !(next ? /^\s*,\s*$/u : /^\s*,?\s*$/u).test(trailing)
  )
    throw new SelectionError(
      "AMBIGUOUS_LIST_TRIVIA",
      "Comments or unsupported trivia in adjacent list gaps have no inferred owner. Use inside for the exact element, or choose explicit text boundaries.",
    );
  if (elements.length === 1) return { startIndex: open + 1, endIndex: close };
  if (next || trailing.includes(","))
    return { startIndex: element.node.startIndex, endIndex: trailingEnd };
  return { startIndex: leadingStart, endIndex: element.node.endIndex };
}
