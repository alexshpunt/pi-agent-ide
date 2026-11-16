import { Type } from "typebox";
import { expect, test } from "vitest";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";
import { createTextEditorCore } from "#src/core/text-editor-core.ts";
import { TEXT_EDITOR_API_VERSION } from "#src/api/plugin-protocol.ts";

const schema = Type.Object(
  {
    file: Type.Optional(Type.String()),
    start: Type.String(),
    end: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function registration(name = "fixture"): TextMutationToolRegistration<typeof schema> {
  return {
    name,
    description: "Fixture mutation.",
    parameters: schema,
    source: { field: "file", inherited: true },
    anchors: [
      {
        field: "start",
        sourceField: "file",
        kinds: ["fixture/position"],
        nonAnchorValues: ["last"],
      },
      { field: "end", sourceField: "file", kinds: ["fixture/position"], optional: true },
    ],
    pair: ["start", "end"],
    mutate: (context) => ({
      edits: new Map([
        ["fixture", { changes: [context.sourceDocument.replaceAll("fixture")], action: "edited" }],
      ]),
    }),
  };
}

test("commits plugin mutation registrations through the same registry", async () => {
  const core = createTextEditorCore();
  await core.registerPlugin({
    protocol: "pi-agent-text-editor",
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-plugin",
    setup(api) {
      api.addMutationTool(registration("plugin-fixture"));
    },
  });

  expect(core.getMutationTools().map(({ name }) => name)).toEqual(["plugin-fixture"]);
});

test("keeps explicit tool renderer slots over fallback slots", async () => {
  const core = createTextEditorCore();
  const explicitCall = (): never => {
    throw new Error("not called");
  };
  const fallbackCall = (): never => {
    throw new Error("not called");
  };
  const fallbackResult = (): never => {
    throw new Error("not called");
  };

  await core.registerPlugin({
    protocol: "pi-agent-text-editor",
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "explicit-renderer",
    setup(api) {
      api.addToolRenderer({ tool: "external-mutation", renderCall: explicitCall });
    },
  });
  await core.registerPlugin({
    protocol: "pi-agent-text-editor",
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fallback-renderer",
    setup(api) {
      api.addToolRenderer({
        tool: "external-mutation",
        fallback: true,
        renderCall: fallbackCall,
        renderResult: fallbackResult,
      });
    },
  });

  expect(core.getToolRenderer("external-mutation")).toMatchObject({
    renderCall: explicitCall,
    renderResult: fallbackResult,
  });
});
