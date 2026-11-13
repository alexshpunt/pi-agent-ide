import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";

import { nullableValueSchema } from "./index.ts";
import { searchValue } from "./search.ts";

const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
const shown = `<system-result note="Internal reference; not part of the file. Do not edit."><uuid>${uuid}</uuid></system-result>\nreadable`;
const cwd = "/work/project";

function match(index: number, extra: Record<string, unknown> = {}) {
  return {
    source: `${cwd}/src/file${String(index % 3)}.ts`,
    target: `RESULT#00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    range: { startLine: index + 1, startColumn: 2, endLine: index + 1, endColumn: 5 },
    matchedText: `text ${String(index)}`,
    references: {
      line: `SEARCH#AB12:${String(index + 1)}:line`,
      match: `SEARCH#AB12:${String(index + 1)}:match`,
    },
    ...extra,
  };
}

// Every registered Search result has a target that selects all its matches.
const success = (data: Record<string, unknown>) => ({
  shown,
  outcome: { status: "success", data: { target: "RESULT#whole", ...data }, errors: [] },
  content: [],
  details: {},
  cwd,
});

describe("searchValue", () => {
  test("resolves to every match with its path, line, whole text and id", () => {
    const matches = Array.from({ length: 150 }, (_, index) => match(index));
    const value = searchValue.project(success({ kind: "matches", complete: true, matches }));
    expect(value).toMatchObject({ id: `RESULT#${uuid}`, complete: true });
    const list = (value as { matches: unknown[] }).matches;
    expect(list).toHaveLength(150);
    expect(list[149]).toEqual({
      path: "src/file2.ts",
      line: 150,
      text: "text 149",
      id: "RESULT#00000000-0000-4000-8000-000000000149",
    });
    expect(Value.Check(searchValue.schema, value)).toBe(true);
  });

  test("separates fallback matches from matches of the original query", () => {
    const value = searchValue.project(
      success({
        kind: "matches",
        complete: true,
        matches: [match(0)],
        fallback: "words",
      }),
    );
    expect(value).toEqual({
      complete: true,
      matches: [],
      fallback: {
        mode: "words",
        id: `RESULT#${uuid}`,
        complete: true,
        matches: [
          {
            path: "src/file0.ts",
            line: 1,
            text: "text 0",
            id: "RESULT#00000000-0000-4000-8000-000000000000",
          },
        ],
      },
    });
    expect(Value.Check(searchValue.schema, value)).toBe(true);
  });
  test("keeps incomplete fallback coverage and warnings separate from the completed original search", () => {
    const value = searchValue.project(
      success({
        kind: "matches",
        complete: false,
        matches: [match(0)],
        fallback: "regex",
        notices: ["Fallback tried"],
        editWarning: "Refine before editing",
      }),
    );
    expect(value).toMatchObject({
      complete: true,
      matches: [],
      fallback: { mode: "regex", complete: false },
      notices: ["Fallback tried"],
      editWarning: "Refine before editing",
    });
    expect(Value.Check(searchValue.schema, value)).toBe(true);
  });
  test("keeps the whole matched text however long it is", () => {
    const text = "x".repeat(20_000);
    const value = searchValue.project(
      success({ kind: "matches", complete: true, matches: [match(0, { matchedText: text })] }),
    ) as { matches: { text: string }[] };
    expect(value.matches[0]?.text).toBe(text);
  });

  test("no match is an empty list, and incomplete coverage stays visible", () => {
    for (const complete of [true, false]) {
      expect(searchValue.project(success({ kind: "matches", complete, matches: [] }))).toEqual({
        id: `RESULT#${uuid}`,
        complete,
        matches: [],
      });
    }
  });

  test("preserves notices but leaves out possible-name suggestions", () => {
    const value = searchValue.project(
      success({
        kind: "matches",
        complete: true,
        matches: [],
        notices: ["Boolean query"],
        fuzzy: { status: "ready", candidates: [{ identifier: "fooBar", matchCount: 3 }] },
      }),
    );
    expect(value).toEqual({
      id: `RESULT#${uuid}`,
      complete: true,
      matches: [],
      notices: ["Boolean query"],
    });
  });

  test("paths outside the session directory and remote paths stay as they are", () => {
    const value = searchValue.project(
      success({
        kind: "matches",
        complete: true,
        matches: [
          match(0, { source: "/elsewhere/a.ts" }),
          match(1, { source: "ssh://host/home/a.ts" }),
          match(2, { source: `${cwd}-other/b.ts` }),
        ],
      }),
    ) as { matches: { path: string }[] };
    expect(value.matches.map((item) => item.path)).toEqual([
      "/elsewhere/a.ts",
      "ssh://host/home/a.ts",
      `${cwd}-other/b.ts`,
    ]);
  });

  test("a list an older resolver cut short is not complete", () => {
    const value = searchValue.project(
      success({ kind: "matches", complete: true, truncated: true, matches: [match(0)] }),
    );
    expect(value).toMatchObject({ complete: false });
  });

  test("matches in a source without selections have no ids", () => {
    const value = searchValue.project(
      success({
        kind: "matches",
        target: undefined,
        complete: true,
        matches: [
          match(0, { source: "shell:build", target: undefined }),
          match(1, { source: "docs:terminal", target: undefined }),
        ],
      }),
    );
    expect(value).toEqual({
      complete: true,
      matches: [
        { path: "shell:build", line: 1, text: "text 0" },
        { path: "docs:terminal", line: 2, text: "text 1" },
      ],
    });
    expect(Value.Check(searchValue.schema, value)).toBe(true);
    expect(
      searchValue.project(
        success({ kind: "matches", target: undefined, complete: true, matches: [] }),
      ),
    ).toEqual({ complete: true, matches: [] });
  });

  test("a result that is not a list of text matches resolves to the readable result", () => {
    for (const data of [
      { kind: "custom", resolverId: "linear", value: { issues: [] } },
      { kind: "files", complete: true, files: ["a.ts"] },
      { kind: "matches", complete: true, matches: [match(0, { matchedText: undefined })] },
    ])
      expect(searchValue.project(success(data))).toBe(shown);
  });

  test("declares the match list or the readable result, or null for a failed call", () => {
    const variants = nullableValueSchema(searchValue).anyOf as { type: string }[];
    expect(variants.map((variant) => variant.type)).toEqual(["object", "string", "null"]);
  });
});
