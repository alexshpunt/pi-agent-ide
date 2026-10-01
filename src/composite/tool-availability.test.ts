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
