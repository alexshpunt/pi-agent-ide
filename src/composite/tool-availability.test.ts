import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createIdeToolAvailability } from "./tool-availability.js";

// The fake keeps registration state only; real-Pi tests own native execution and lifecycle.
test("an excluded IDE tool stays hidden when registered again and keeps live metadata", () => {
  const tools = new Map<
    string,
    Pick<
      ToolDefinition,
      | "name"
      | "description"
      | "promptGuidelines"
      | "parameters"
      | "exposure"
      | "namespace"
      | "annotations"
    >
  >();
  let selection = ["-read"];
  let active: string[] = [];
  let description = "Initial read description";
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    tools.set(tool.name, defineTool(tool));
  };
  const pi: Pick<
    ExtensionAPI,
    "registerTool" | "getSettings" | "getAllTools" | "getActiveTools" | "setActiveTools"
  > = {
    registerTool,
    getSettings: () => ({ defaultTools: selection }),
    getAllTools: () =>
      [...tools.values()].map((tool) => ({
        ...tool,
        exposure: tool.exposure ?? "direct",
        sourceInfo: {
          path: "test",
          source: "inline",
          scope: "temporary",
          origin: "top-level",
        } as const,
      })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  const availability = createIdeToolAvailability(pi);
  const read = defineTool({
    name: "read",
    label: "Read",
    exposure: "direct",
    namespace: { name: "ide_read", description: "Read resources." },
    annotations: { readOnlyHint: false },
    get description() {
      return description;
    },
    get promptGuidelines() {
      return [description];
    },
    parameters: Type.Object({}),
    async execute() {
      return { content: [], details: undefined };
    },
  });
  availability.api.registerTool(read);
  availability.reconcile(true);
  availability.api.registerTool(read);
  description = "Updated read description";
  const hidden = tools.get("read");
  expect(hidden?.exposure).toBe("hidden");
  expect(hidden?.description).toBe(description);
  expect(hidden?.promptGuidelines).toEqual([description]);
  expect(hidden?.namespace).toBe(read.namespace);
  expect(hidden?.annotations).toBe(read.annotations);
  selection = ["+read"];
  availability.reconcile(true);
  expect(tools.get("read")).toBe(read);
  expect(active).toContain("read");
});

test.each([undefined, { name: "external_fixture", description: "Fixture namespace" }])(
  "capability loader exclusions apply before reconciliation regardless of namespace (%s)",
  (namespace) => {
    const name = "ide_capability_fixture";
    let selection = [`+${name}`, `-${name}`];
    let description = "fixture-initial";
    let parameters = Type.Object({});
    const tools = new Map<
      string,
      Pick<
        ToolDefinition,
        "exposure" | "parameters" | "description" | "promptGuidelines" | "namespace"
      > & { execute: unknown }
    >();
    const registerTool: ExtensionAPI["registerTool"] = (tool) => {
      tools.set(tool.name, defineTool(tool));
    };
    const availability = createIdeToolAvailability({
      registerTool,
      getSettings: () => ({ defaultTools: selection }),
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
    });
    const loader = defineTool({
      name,
      label: name,
      exposure: "deferred",
      namespace,
      get description() {
        return description;
      },
      get promptGuidelines() {
        return [description];
      },
      get parameters() {
        return parameters;
      },
      async execute() {
        return { content: [], details: undefined };
      },
    });
    availability.api.registerTool(loader);
    const hidden = tools.get(name);
    expect(hidden?.exposure).toBe("hidden");
    expect(hidden?.execute).toBe(loader.execute);
    expect(hidden?.namespace).toBe(namespace);
    description = "fixture-updated";
    parameters = Type.Object({});
    expect(hidden?.description).toBe(description);
    expect(hidden?.promptGuidelines).toEqual([description]);
    expect(hidden?.parameters).toBe(parameters);
    selection = [`-${name}`, `+${name}`];
    availability.api.registerTool(loader);
    expect(tools.get(name)).toBe(loader);
    selection = [`-${name}`];
    availability.reconcile();
    expect(tools.get(name)?.exposure).toBe("hidden");
    selection = [`-${name}`, name];
    availability.api.registerTool(loader);
    expect(tools.get(name)).toBe(loader);
    selection = [`-${name}`];
    availability.api.registerTool(loader);
    expect(tools.get(name)?.exposure).toBe("hidden");
    selection = [];
    availability.reconcile();
    expect(tools.get(name)).toBe(loader);
  },
);
