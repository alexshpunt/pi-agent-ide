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
const plan = (active: string[], registered = tools) =>
  getIdeToolGuidance(registered, active).map(({ names, discovery }) => ({ names, discovery }));

test.each(names)("active %s gets usage guidance without discovery", (name) => {
  const entry = plan([name, "tool_search"]).find((entry) => entry.names.includes(name));
  expect(entry).toEqual({ names: [name], discovery: undefined });
});

test.each([
  [["tool_search", "codemode"], "tool_search"],
  [["codemode"], "codemode"],
  [[], "enable_tool_search"],
] as const)("inactive tools retain the discovery route for %j", (active, discovery) => {
  const guidance = plan([...active]);
  expect(guidance.flatMap((entry) => entry.names)).toEqual(names);
  expect(guidance.every((entry) => entry.discovery === discovery)).toBe(true);
});

test("Git tools stay grouped only when their active states match", () => {
  expect(plan(["stage", "unstage"]).find((entry) => entry.names.includes("stage"))).toEqual({
    names: ["stage", "unstage"],
    discovery: undefined,
  });
  expect(
    plan(["stage", "tool_search"]).filter((entry) =>
      entry.names.some((name) => ["stage", "unstage"].includes(name)),
    ),
  ).toEqual([
    { names: ["stage"], discovery: undefined },
    { names: ["unstage"], discovery: "tool_search" },
  ]);
});

test("guidance follows the current active loadout rather than registered exposure", () => {
  const diff = (active: string[]) => plan(active).find((entry) => entry.names.includes("diff"));
  expect(diff(["diff"])).toEqual({ names: ["diff"], discovery: undefined });
  expect(diff([])).toEqual({ names: ["diff"], discovery: "enable_tool_search" });
  expect(diff(["diff"])).toEqual({ names: ["diff"], discovery: undefined });
});

test("missing and hidden tools receive no guidance, even if listed as active", () => {
  expect(plan(names, [])).toEqual([]);
  const hidden = tools.map((tool) => ({ ...tool, exposure: "hidden" as const }));
  expect(getIdeToolGuidance(hidden, names)).toEqual([]);
});

test("debug guidance belongs only to the IDE debugger namespace", () => {
  const debug = {
    name: "debug",
    exposure: "deferred" as const,
    namespace: { name: "external", description: "Fixture" },
  };
  expect(getIdeToolGuidance([debug], ["debug"])).toEqual([]);
});
