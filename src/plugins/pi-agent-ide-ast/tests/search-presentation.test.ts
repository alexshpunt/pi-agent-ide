import { expect, test } from "vitest";
import { isSearchToolDetails } from "pi-agent-search-text/result";

import { createAstSearchPresentation } from "#src/search-presentation.js";

test("groups AST matches and highlights every matched line", () => {
  const details = createAstSearchPresentation(
    "ast:function $NAME($$$ARGS) { $$$BODY }",
    [
      {
        file: "src/example.ts",
        lines: "export function sum(a: number, b: number) {\n  return a + b;\n}",
        range: {
          start: { line: 4, column: 7 },
          end: { line: 6, column: 1 },
        },
      },
    ],
    true,
    "/workspace",
    "ABC123",
  );

  expect(details).toMatchObject({ matchCount: 1, fileCount: 1, complete: true });
  expect(isSearchToolDetails(details)).toBe(true);
  expect(details.files[0]).toMatchObject({ path: "src/example.ts", matchCount: 1 });
  expect(details.files[0]?.lines).toEqual([
    {
      lineNumber: 5,
      text: "export function sum(a: number, b: number) {",
      matchCount: 1,
      ranges: [{ from: 7, to: 43 }],
      logicalMatchIds: ["src/example.ts:0"],
    },
    {
      lineNumber: 6,
      text: "  return a + b;",
      matchCount: 1,
      ranges: [{ from: 0, to: 15 }],
      logicalMatchIds: ["src/example.ts:0"],
    },
    {
      lineNumber: 7,
      text: "}",
      matchCount: 1,
      ranges: [{ from: 0, to: 1 }],
      logicalMatchIds: ["src/example.ts:0"],
    },
  ]);
});
