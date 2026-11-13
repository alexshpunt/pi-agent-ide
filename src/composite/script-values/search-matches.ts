import { scriptMatchPath, scriptMatchSchema, type ScriptMatch } from "./match.ts";
import { resultReference } from "./result-reference.ts";
import type { ScriptValueInput } from "./types.ts";

/** One match of a search value, with the resolver's record of it for tool-specific fields. */
export interface MatchEntry {
  readonly match: ScriptMatch;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Schema of a search value: `{ id, complete, matches }`, where `match` describes one match, or the
 * readable result of a search whose results are not text matches, such as a provider's object
 * list.
 */
export function matchListSchema(match: Readonly<Record<string, unknown>> = scriptMatchSchema) {
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "RESULT#<uuid> that selects every match. Absent when the source has no selections, such as terminal output or a guide.",
          },
          complete: {
            type: "boolean",
            description:
              "False when the search did not cover its whole scope: an empty list then proves nothing.",
          },
          matches: { type: "array", items: match },
        },
        required: ["complete", "matches"],
        additionalProperties: false,
      },
      {
        type: "string",
        description:
          "Readable result of a search whose results are not text matches, such as a provider's object list.",
      },
    ],
  };
}

/**
 * Every match of a successful search, in the resolver's order, with the reference of the whole
 * result when it selects text. Undefined when the result is not a list of text matches, such as a
 * provider's object list; the tool then resolves to its readable result.
 */
export function matchList(
  input: ScriptValueInput,
): { id?: string; complete: boolean; matches: MatchEntry[] } | undefined {
  const data =
    record(input.outcome) && input.outcome.status === "success" ? input.outcome.data : undefined;
  const reference = resultReference(input.shown);
  if (
    reference === undefined ||
    !record(data) ||
    data.kind !== "matches" ||
    !Array.isArray(data.matches) ||
    typeof data.complete !== "boolean"
  )
    return undefined;
  const matches: MatchEntry[] = [];
  for (const item of data.matches as unknown[]) {
    if (!record(item)) return undefined;
    const match = scriptMatch(item, input.cwd);
    if (match === undefined) return undefined;
    matches.push({ match, data: item });
  }
  return {
    // The published result selects text only when its record names a target; the result of a
    // search in terminal output or a guide selects nothing to pass on.
    ...(typeof data.target === "string" && { id: reference }),
    // A shortened list is not complete: the preview record of a call that no script made, or the
    // list of a resolver built against an older SDK that still cuts it at 100 matches.
    complete: data.complete && data.truncated !== true,
    matches,
  };
}

/** One matched text of a resolver record, or undefined when the record lacks a field. */
export function scriptMatch(
  data: Readonly<Record<string, unknown>>,
  cwd: string | undefined,
): ScriptMatch | undefined {
  const { source, matchedText, target, range } = data;
  const line = record(range) ? range.startLine : undefined;
  if (typeof source !== "string" || typeof matchedText !== "string" || typeof line !== "number")
    return undefined;
  return {
    path: scriptMatchPath(source, cwd),
    line,
    text: matchedText,
    // A match in a source without selections, such as terminal output, has no reference.
    ...(typeof target === "string" && { id: target }),
  };
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
