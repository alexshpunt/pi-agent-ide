import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";

import { astSearchValue } from "./ast-search.ts";

const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const shown = `<system-result note="Internal reference; not part of the file. Do not edit."><uuid>${uuid}</uuid></system-result>\nreadable`;
const cwd = "/work/project";

function node(text: string, target: string, line = 3) {
  return {
    source: `${cwd}/client.ts`,
    target,
    range: { startLine: line, startColumn: 0, endLine: line, endColumn: text.length },
    matchedText: text,
  };
}

const success = (matches: unknown[]) => ({
  shown,
  outcome: {
    status: "success",
    data: { kind: "matches", target: "RESULT#whole", complete: true, matches },
    errors: [],
  },
  content: [],
  details: {},
  cwd,
});

describe("astSearchValue", () => {
  test("adds each metavariable's nodes as { text, id }, keyed without $", () => {
    const args = Array.from({ length: 120 }, (_, index) =>
      node(`arg${String(index)}`, `RESULT#arg-${String(index)}`),
    );
    const value = astSearchValue.project(
      success([
        {
          ...node("request(options, ...rest)", "RESULT#call"),
          captures: { OPTIONS: [node("options", "RESULT#options")], ARGS: args },
        },
      ]),
    );
    expect(value).toMatchObject({
      id: `RESULT#${uuid}`,
      complete: true,
      matches: [
        {
          path: "client.ts",
          line: 3,
          text: "request(options, ...rest)",
          id: "RESULT#call",
          captures: { OPTIONS: [{ text: "options", id: "RESULT#options" }] },
        },
      ],
    });
    const captures = (value as { matches: { captures: Record<string, unknown[]> }[] }).matches[0]
      ?.captures;
    expect(captures?.ARGS).toHaveLength(120);
    expect(captures?.ARGS?.[119]).toEqual({ text: "arg119", id: "RESULT#arg-119" });
    expect(Value.Check(astSearchValue.schema, value)).toBe(true);
  });

  test("a match without metavariables has empty captures", () => {
    const value = astSearchValue.project(success([node("request()", "RESULT#call")]));
    expect(value).toMatchObject({ matches: [{ captures: {} }] });
    expect(Value.Check(astSearchValue.schema, value)).toBe(true);
  });

  test("a capture node without a selection keeps its text without an id", () => {
    const value = astSearchValue.project(
      success([
        {
          ...node("request(options)", "RESULT#call"),
          captures: { OPTIONS: [{ ...node("options", "RESULT#options"), target: undefined }] },
        },
      ]),
    );
    expect(value).toMatchObject({ matches: [{ captures: { OPTIONS: [{ text: "options" }] } }] });
    const [capture] =
      (value as { matches: { captures: { OPTIONS: object[] } }[] }).matches[0]?.captures.OPTIONS ??
      [];
    expect(capture).not.toHaveProperty("id");
    expect(Value.Check(astSearchValue.schema, value)).toBe(true);
  });

  test("a capture node without its text resolves to the readable result", () => {
    const value = astSearchValue.project(
      success([
        {
          ...node("request(options)", "RESULT#call"),
          captures: { OPTIONS: [{ ...node("options", "RESULT#options"), matchedText: undefined }] },
        },
      ]),
    );
    expect(value).toBe(shown);
  });
});
