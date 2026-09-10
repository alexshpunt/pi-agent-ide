import { expect, test } from "vitest";
import { Type } from "typebox";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";

test("index operations are unavailable until their plugin registers them", async () => {
  const core = createTextEditorCore();
  expect(core.getScriptIndexOperation("stage")).toBeUndefined();
  const operation = {
    name: "stage" as const,
    parameters: Type.Object({ file: Type.String() }),
    async execute() {
      return { content: [], details: { state: "staged" } };
    },
  };
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "index",
    setup(api) {
      api.addScriptIndexOperation(operation);
    },
  });
  expect(core.getScriptIndexOperation("stage")).toBe(operation);
  expect(core.getScriptIndexOperation("unstage")).toBeUndefined();
});

test("duplicate index registrations reject the complete plugin draft", async () => {
  const core = createTextEditorCore();
  const operation = {
    name: "stage" as const,
    parameters: Type.Object({}),
    async execute() {
      return { content: [], details: {} };
    },
  };
  await expect(
    core.registerPlugin({
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "duplicate",
      setup(api) {
        api.addScriptIndexOperation(operation);
        api.addScriptIndexOperation(operation);
      },
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(core.getScriptIndexOperation("stage")).toBeUndefined();
});
