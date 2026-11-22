import { expect, test } from "vitest";
import { getIdeToolGuidance } from "./tool-discovery-guidance.ts";

const names = ["ast_search", "lsp_search", "diff", "undo", "stage", "unstage", "debug"];
const tools = names.map((name) => ({
  name,
  exposure: "deferred" as const,
  namespace: {
    name: name === "stage" || name === "unstage" ? "ide_git" : `ide_${name}`,
    description: "Fixture namespace",
  },
}));

test("registered IDE tools are listed once, with Git tools grouped", () => {
  expect(getIdeToolGuidance(tools).map(({ names }) => names)).toEqual([
    ["ast_search"],
    ["lsp_search"],
    ["diff"],
    ["undo"],
    ["stage", "unstage"],
    ["debug"],
  ]);
});

test("missing and hidden tools receive no guidance", () => {
  expect(getIdeToolGuidance([])).toEqual([]);
  const hidden = tools.map((tool) => ({ ...tool, exposure: "hidden" as const }));
  expect(getIdeToolGuidance(hidden)).toEqual([]);
});

test("debug guidance belongs only to the IDE debugger namespace", () => {
  const debug = {
    name: "debug",
    exposure: "deferred" as const,
    namespace: { name: "external", description: "Fixture" },
  };
  expect(getIdeToolGuidance([debug])).toEqual([]);
});
