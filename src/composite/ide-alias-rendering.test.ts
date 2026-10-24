import type {
  ExtensionAPI,
  ToolDefinition,
  ToolInfo,
  ToolLoadout,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createNestedIdeRendering } from "./nested-tool-rendering.js";

function fixture() {
  const tools: ToolInfo[] = [];
  let resolver: ToolRendererResolver | undefined;
  let beforeStart: (() => void) | undefined;
  const registered: ToolDefinition[] = [];
  const stub: Partial<ExtensionAPI> = {
    on: (event, handler) => {
      if (event === "before_agent_start") beforeStart = handler as () => void;
      return () => {};
    },
    registerEntryRenderer: () => {},
    registerToolRenderer: (value: ToolRendererResolver) => {
      resolver = value;
    },
    getAllTools: () => tools,
    registerTool: (definition) => {
      registered.push(definition as ToolDefinition);
    },
  };
  const rendering = createNestedIdeRendering(stub as ExtensionAPI);
  const definition: ToolDefinition = {
    name: "read",
    label: "Read",
    description: "Read fixture resources.",
    namespace: { name: "ide_read", description: "IDE read." },
    parameters: Type.Object({ path: Type.String() }),
    renderCall: () => new Text("NATIVE_CALL", 0, 0),
    renderResult: () => new Text("NATIVE_RESULT", 0, 0),
    execute: async () => ({ content: [], details: undefined }),
  };
  rendering.api.registerTool(definition);
  const sourceInfo = {
    path: "fixture",
    source: "inline",
    scope: "temporary",
    origin: "top-level",
  } as const;
  tools.push({ ...definition, exposure: "direct", sourceInfo });
  const alias: ToolInfo = {
    name: "mcp__connector__read",
    description: definition.description,
    parameters: definition.parameters,
    exposure: "direct",
    sourceInfo,
  };
  const fallback = { renderCall: () => new Text("FOREIGN_CALL", 0, 0) };
  const resolve = () => resolver?.(alias.name, () => fallback);
  return { tools, definition, alias, fallback, resolve, registered, start: () => beforeStart?.() };
}

test("resolving a late local alias selects the complete native renderer without registration", () => {
  const run = fixture();
  run.tools.push(run.alias);
  expect(run.resolve()?.renderCall).toBe(run.definition.renderCall);
  expect(run.resolve()?.renderResult).toBe(run.definition.renderResult);
});

test("forwarding keeps the source output schema and the alias exposure", () => {
  const run = fixture();
  run.definition.outputSchema = { type: "object", additionalProperties: true };
  run.alias.exposure = "deferred";
  run.tools.push(run.alias);
  run.start();
  const forwarded = run.registered.find((tool) => tool.name === run.alias.name);
  expect(forwarded?.outputSchema).toBe(run.definition.outputSchema);
  expect(forwarded?.exposure).toBe("deferred");
  expect(forwarded?.namespace).toBeUndefined();
});
function loadout(run: ReturnType<typeof fixture>, native = true): ToolLoadout {
  return {
    declared: (native ? [run.definition, run.alias] : [run.alias]).map((tool) => ({
      ...tool,
      label: tool.name,
      execute: async () => ({ content: [], details: undefined }),
    })),
    callable: [],
    registered: [],
    getExposure: () => "direct",
    getNamespace: () => undefined,
    getPromptGuidelines: () => [],
  };
}

test("a forwarding alias stays callable without declaring the native contract twice", () => {
  const run = fixture();
  run.tools.push(run.alias);
  run.start();
  const forwarded = run.registered.find((tool) => tool.name === run.alias.name);
  expect(forwarded?.exposure).toBe("deferred");
  expect(forwarded?.prepareLoadout?.(loadout(run))).toEqual({
    hiddenDeclarations: [run.alias.name],
  });
  expect(forwarded?.prepareLoadout?.(loadout(run, false))?.hiddenDeclarations ?? []).toEqual([]);
});

test("alias deduplication composes with the source loadout hook", () => {
  const run = fixture();
  run.definition.prepareLoadout = () => ({
    descriptions: { other: "Other description" },
    hiddenDeclarations: ["other"],
  });
  run.tools.push(run.alias);
  run.start();
  const forwarded = run.registered.find((tool) => tool.name === run.alias.name);
  expect(forwarded?.prepareLoadout?.(loadout(run))).toEqual({
    descriptions: { other: "Other description" },
    hiddenDeclarations: ["other", run.alias.name],
  });
});
test.each(["namespace", "schema", "description", "hidden"] as const)(
  "do not take over aliases with a foreign %s",
  (change) => {
    const run = fixture();
    if (change === "namespace")
      run.alias.namespace = { name: "mcp__foreign", description: "Remote MCP." };
    if (change === "schema") run.alias.parameters = Type.Object({ command: Type.String() });
    if (change === "description") run.alias.description = "A different read tool.";
    const source = run.tools[0];
    if (change === "hidden" && source) source.exposure = "hidden";
    run.tools.push(run.alias);
    expect(run.resolve()).toBe(run.fallback);
    run.start();
    expect(run.registered.some((tool) => tool.name === run.alias.name)).toBe(false);
  },
);
