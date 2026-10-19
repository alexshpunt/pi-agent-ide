import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolInfo,
  type ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { registerIdeAliasCompatibility } from "./ide-alias-rendering.js";

function fixture() {
  const definitions: ToolDefinition[] = [];
  const capture: Partial<ExtensionAPI> = {
    registerTool: (definition) => {
      definitions.push(definition as ToolDefinition);
    },
  };
  void createCodemodeExtension()(capture as ExtensionAPI);
  const builtin = definitions[0];
  if (!builtin) throw Error("Builtin Codemode definition missing");
  const sourceInfo = {
    path: "builtin:codemode",
    source: "builtin",
    scope: "temporary",
    origin: "top-level",
  } as const;
  const canonical: ToolInfo = { ...builtin, exposure: "model-only", sourceInfo };
  const alias: ToolInfo = {
    name: "mcp__builtin_codemode__codemode",
    description: canonical.description,
    parameters: canonical.parameters,
    exposure: "direct",
    sourceInfo: { ...sourceInfo, source: "cli", path: "fixture" },
  };
  const tools = [canonical, alias];
  const registered: string[] = [];
  let resolver: ToolRendererResolver | undefined;
  const api: Partial<ExtensionAPI> = {
    getAllTools: () => tools,
    registerTool: (definition) => {
      registered.push(definition.name);
    },
    registerToolRenderer: (value) => {
      resolver = value;
    },
    on: () => () => {},
  };
  registerIdeAliasCompatibility(api as ExtensionAPI, new Map());
  const fallback = {};
  return {
    builtin,
    canonical,
    alias,
    registered,
    fallback,
    resolve: (name = alias.name) => resolver?.(name, () => fallback),
  };
}

test("the first local builtin Codemode alias uses shipped renderers without registering execution", () => {
  const run = fixture();
  const renderer = run.resolve();
  expect(renderer?.renderCall).toBe(run.builtin.renderCall);
  expect(renderer?.renderResult).toBe(run.builtin.renderResult);
  expect(renderer?.renderShell).toBe(run.builtin.renderShell);
  expect(run.registered).toEqual([]);
  expect(run.resolve("codemode")).toBe(run.fallback);
});

test.each(["namespace", "schema", "description", "hidden", "custom-source"] as const)(
  "a %s mismatch retains the alias renderer",
  (change) => {
    const run = fixture();
    if (change === "namespace")
      run.alias.namespace = { name: "foreign", description: "Foreign MCP server" };
    if (change === "schema") run.alias.parameters = { type: "object", properties: {} };
    if (change === "description") run.alias.description += " different contract";
    if (change === "hidden") run.canonical.exposure = "hidden";
    if (change === "custom-source")
      run.canonical.sourceInfo = { ...run.canonical.sourceInfo, source: "cli", path: "custom" };
    expect(run.resolve()).toBe(run.fallback);
    expect(run.registered).toEqual([]);
  },
);
