import { describe, expect, test } from "vitest";

import {
  selectionData,
  selectionPreview,
} from "#src/extensions/pi-agent-search/src/api/structured-result.ts";
import { nullableValueSchema } from "./index.ts";
import { lspSearchValue } from "./lsp-search.ts";

const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
const shown = `<system-result note="Internal reference; not part of the file. Do not edit."><uuid>${uuid}</uuid></system-result>\nLSP symbols inside scope`;
const input = (data: unknown) => ({
  shown,
  outcome: { status: "success", data, errors: [] },
  content: [],
  details: {},
  cwd: "/work",
});
const hit = (line: number, text: string) => ({
  source: "/work/src/app.ts",
  lineNumber: line,
  startColumn: 0,
  endColumn: text.length,
  matchedText: text,
});
const targets = (count: number, list = "match") => ({
  target: `RESULT#${list}`,
  matchTargets: Array.from({ length: count }, (_, index) => `RESULT#${list}-${String(index)}`),
});

describe("lspSearchValue", () => {
  test("query and references resolve to every match with its own id", () => {
    // More than the 100 matches a direct call shows.
    const hits = Array.from({ length: 150 }, (_, index) => hit(index + 1, `start${String(index)}`));
    const value = lspSearchValue.project(input(selectionData(hits, true, "AB12", targets(150))));
    expect(value).toMatchObject({ id: `RESULT#${uuid}`, complete: true });
    const matches = (value as { matches: unknown[] }).matches;
    expect(matches).toHaveLength(150);
    expect(matches[149]).toEqual({
      path: "src/app.ts",
      line: 150,
      text: "start149",
      id: "RESULT#match-149",
    });
  });

  test("a declaration resolves to one match with the whole declaration text", () => {
    // Longer than the 4 KB of text a direct call's record keeps.
    const body = `function start() {\n${"  work();\n".repeat(1000)}}\n`;
    const data = selectionData([hit(3, body)], true, "AB12", targets(1));
    expect(lspSearchValue.project(input(data))).toEqual({
      id: `RESULT#${uuid}`,
      complete: true,
      matches: [{ path: "src/app.ts", line: 3, text: body, id: "RESULT#match-0" }],
    });
  });

  test("an incomplete search keeps complete: false, and no match is an empty list", () => {
    const data = selectionData([], false, "AB12", targets(0));
    expect(lspSearchValue.project(input(data))).toEqual({
      id: `RESULT#${uuid}`,
      complete: false,
      matches: [],
    });
  });

  const graph = (complete: boolean) => {
    const list = (line: number, text: string, name: string) =>
      selectionData([hit(line, text)], complete, "AB12", targets(1, name));
    return {
      kind: "custom",
      resolverId: "lsp",
      value: {
        target: "RESULT#references",
        complete,
        matches: list(9, "save", "ref"),
        incoming: list(8, "function submit() {\n  save();\n}\n", "caller"),
        outgoing: list(20, "function validate() {}\n", "callee"),
      },
    };
  };

  test("calls resolve to references, callers and callees, each with its own ids", () => {
    expect(lspSearchValue.project(input(graph(true)))).toEqual({
      id: "RESULT#references",
      complete: true,
      matches: [{ path: "src/app.ts", line: 9, text: "save", id: "RESULT#ref-0" }],
      incoming: [
        {
          path: "src/app.ts",
          line: 8,
          text: "function submit() {\n  save();\n}\n",
          id: "RESULT#caller-0",
        },
      ],
      outgoing: [
        { path: "src/app.ts", line: 20, text: "function validate() {}\n", id: "RESULT#callee-0" },
      ],
    });
  });

  test("a call graph past the compiler's error limit stays incomplete", () => {
    expect(lspSearchValue.project(input(graph(false)))).toMatchObject({ complete: false });
  });

  test("a shortened list of a call graph is not complete", () => {
    const callers = Array.from({ length: 150 }, (_, index) => hit(index + 1, "caller"));
    const data = graph(true);
    const value = { ...data.value, incoming: selectionData(callers, true, "AB12", targets(150)) };
    expect(lspSearchValue.project(input(selectionPreview({ ...data, value })))).toMatchObject({
      complete: false,
    });
  });

  test("data without the fields a value needs resolves to the readable result", () => {
    expect(lspSearchValue.project(input({ kind: "custom", resolverId: "lsp", value: {} }))).toBe(
      shown,
    );
  });

  test("the declared value is a call graph, a match list, the readable result or null", () => {
    const variants = nullableValueSchema(lspSearchValue).anyOf as { required?: string[] }[];
    expect(variants.map((variant) => variant.required)).toEqual([
      ["id", "complete", "matches", "incoming", "outgoing"],
      ["complete", "matches"],
      undefined,
      undefined,
    ]);
  });
});
