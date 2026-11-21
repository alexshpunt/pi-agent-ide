import { resultValueId } from "pi-agent-resource";
import { TextMutationInputError, type TextMutationAnchorField } from "#src/api/mutation-tool.ts";
import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";

export const sourceSelectors = ["at", "from", "after", "through", "before"] as const;
export const targetSelectors = [
  "targetAt",
  "targetFrom",
  "targetAfter",
  "targetThrough",
  "targetBefore",
] as const;
export const insertSelectors = ["after", "before"] as const;
const retiredSourceSelectors = ["start", "end"] as const;
const retiredTargetSelectors = ["targetStart", "targetEnd"] as const;

const transferSelectors = [...sourceSelectors, ...targetSelectors];
const toolSelectors = new Map<string, readonly string[]>([
  ["replace", sourceSelectors],
  ["delete", sourceSelectors],
  ["copy", transferSelectors],
  ["move", transferSelectors],
  ["insert", insertSelectors],
]);

export function editingSelectorFields(tool: string): readonly string[] {
  return toolSelectors.get(tool) ?? [];
}

type Input = Readonly<Record<string, unknown>>;

export function hasTextSelectors(input: Input, fields: readonly string[]): boolean {
  return fields.some((field) => input[field] !== undefined);
}

/** Legacy keys must not fall through to a destructive whole-file or live-resource mode. */
export function hasTransferSelectorKeys(input: Input): boolean {
  return [...transferSelectors, ...retiredSourceSelectors, ...retiredTargetSelectors].some(
    (field) => Object.hasOwn(input, field),
  );
}

export function textSelectorAnchors(
  sourceField: "path" | "target",
  fields: readonly string[],
  pairedEnds: readonly string[] = [],
): TextMutationAnchorField[] {
  return fields.map((field) => ({
    field,
    sourceField,
    kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    ...(pairedEnds.includes(field) && { pairedEnd: true }),
  }));
}

export type TextSelector =
  | { readonly kind: "single" | "insert-before" | "insert-after"; readonly first: string }
  | {
      readonly kind: "range";
      readonly first: string;
      readonly last: string;
      readonly excludeStart: boolean;
      readonly excludeEnd: boolean;
    };

export function selectorFields(selector: TextSelector): readonly string[] {
  return selector.kind === "range" ? [selector.first, selector.last] : [selector.first];
}

/** Check raw selector types before Pi can coerce a scalar into literal text. */
export function checkRawEditingSelectorTypes(tool: string, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return;
  checkSelectorValues(input as Input, editingSelectorFields(tool), true);
}

function checkSelectorValues(input: Input, fields: readonly string[], allowEmpty = false): void {
  for (const field of fields) {
    const value = input[field];
    if (
      value === undefined ||
      (typeof value === "string" && (allowEmpty || value.length > 0)) ||
      resultValueId(value) !== undefined
    )
      continue;
    throw new TextMutationInputError(
      value === "" ? "EMPTY_SELECTOR" : "INVALID_TEXT_SELECTOR",
      `Pass a non-empty selector in ${field}, or omit it.`,
    );
  }
}

function rejectRetiredFields(input: Input, fields: readonly string[], guidance: string): void {
  const field = fields.find((name) => Object.hasOwn(input, name));
  if (field !== undefined)
    throw new TextMutationInputError(
      "INVALID_TEXT_SELECTOR",
      `${field} is not supported. ${guidance}`,
    );
}

export function sourceTextSelector(input: Input): TextSelector | undefined {
  rejectRetiredFields(
    input,
    retiredSourceSelectors,
    "Use at alone or pair from/after with through/before.",
  );
  return readSelector(input, sourceSelectors, false);
}

export function targetTextSelector(input: Input): TextSelector | undefined {
  rejectRetiredFields(
    input,
    retiredTargetSelectors,
    "Use targetAt, a range, or targetAfter/targetBefore alone to insert.",
  );
  return readSelector(input, targetSelectors, true);
}

export interface TextSelectorPair {
  readonly sourceField: string;
  readonly fields: readonly [string, string];
}

/** Return the paired boundaries to inspect together, on each side of the edit. */
export function editingSelectorPairs(tool: string, input: Input): TextSelectorPair[] {
  const pair = (side: "path" | "target", selector: TextSelector | undefined): TextSelectorPair[] =>
    selector?.kind === "range"
      ? [{ sourceField: side, fields: [selector.first, selector.last] }]
      : [];
  if (tool === "copy" || tool === "move")
    return [
      ...pair("path", sourceTextSelector(input)),
      ...pair("target", targetTextSelector(input)),
    ];
  return tool === "replace" || tool === "delete" ? pair("path", sourceTextSelector(input)) : [];
}

export function validateTransferSelectors(input: Input): void {
  sourceTextSelector(input);
  targetTextSelector(input);
}

export function insertTextSelector(input: Input): "after" | "before" {
  rejectRetiredFields(input, ["anchor"], "Pass the selection in after or before.");
  if (typeof input.before === "boolean")
    throw new TextMutationInputError(
      "INVALID_TEXT_SELECTOR",
      "Pass the selection in after or before, not a boolean flag.",
    );
  checkSelectorValues(input, insertSelectors);
  if (input.after !== undefined && input.before !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      "Pass after or before, not both.",
    );
  return input.before === undefined ? "after" : "before";
}

function readSelector(
  input: Input,
  fields: typeof sourceSelectors | typeof targetSelectors,
  allowInsertion: boolean,
): TextSelector | undefined {
  checkSelectorValues(input, fields);
  const [at, from, after, through, before] = fields;
  const opening = input[from] !== undefined ? from : input[after] !== undefined ? after : undefined;
  const closing =
    input[through] !== undefined ? through : input[before] !== undefined ? before : undefined;
  if (input[at] !== undefined) {
    if (opening !== undefined || closing !== undefined)
      throw new TextMutationInputError(
        "CONFLICTING_RANGE_BOUNDARIES",
        `Pass ${at} for a single selection or a pair of range boundaries, not both.`,
      );
    return { kind: "single", first: at };
  }
  if (input[from] !== undefined && input[after] !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      `Pass ${from} or ${after}, not both: ${from} includes the opening match and ${after} excludes it.`,
    );
  if (input[through] !== undefined && input[before] !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      `Pass ${through} or ${before}, not both: ${through} includes the closing match and ${before} excludes it.`,
    );
  if (opening === undefined && closing === undefined) return undefined;
  if (opening === undefined) {
    if (allowInsertion && closing === before) return { kind: "insert-before", first: before };
    throw new TextMutationInputError(
      "MISSING_RANGE_BOUNDARY",
      `Pass ${from} to include the opening match or ${after} to exclude it when using ${closing}.`,
    );
  }
  if (closing === undefined) {
    if (opening === from) return { kind: "single", first: from };
    if (allowInsertion && opening === after) return { kind: "insert-after", first: after };
    throw new TextMutationInputError(
      "MISSING_RANGE_BOUNDARY",
      `Pass ${through} to include the closing match or ${before} to exclude it when using ${opening}. Use ${at} instead for a single selection.`,
    );
  }
  return {
    kind: "range",
    first: opening,
    last: closing,
    excludeStart: opening === after,
    excludeEnd: closing === before,
  };
}
