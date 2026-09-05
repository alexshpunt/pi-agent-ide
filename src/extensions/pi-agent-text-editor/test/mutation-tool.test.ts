import { Type } from "typebox";
import { expect, test, vi } from "vitest";

import {
  type AnyTextMutationToolRegistration,
  assertTextMutationToolRegistration,
  type TextMutationToolRegistration,
} from "#src/api/mutation-tool.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

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

test("validates mutation metadata against its parameter schema", () => {
  expect(() => assertTextMutationToolRegistration(registration())).not.toThrow();
  expect(() =>
    assertTextMutationToolRegistration(
      asMutationRegistration({
        ...registration(),
        anchors: [{ field: "missing", sourceField: "file" }],
      }),
    ),
  ).toThrow("missing");
  expect(() =>
    assertTextMutationToolRegistration(
      asMutationRegistration({
        ...registration(),
        pair: ["start", "missing"],
      }),
    ),
  ).toThrow("is not an anchor");
  expect(() =>
    assertTextMutationToolRegistration(
      asMutationRegistration({
        ...registration(),
        anchors: [{ field: "start", sourceField: "file", kinds: [] }],
      }),
    ),
  ).toThrow("non-empty kinds");
  expect(() =>
    assertTextMutationToolRegistration(
      asMutationRegistration({
        ...registration(),
        anchors: [
          { field: "start", sourceField: "file", kinds: ["fixture/position", "fixture/position"] },
        ],
      }),
    ),
  ).toThrow("duplicate kinds");

  expect(() =>
    assertTextMutationToolRegistration(
      asMutationRegistration({
        ...registration(),
        anchors: [
          {
            field: "start",
            sourceField: "file",
            kinds: ["fixture/position"],
            nonAnchorValues: ["last", "last"],
          },
        ],
      }),
    ),
  ).toThrow("duplicate non-anchor values");
});

test("registers once and replays registrations to late consumers", () => {
  const register = vi.fn();
  const core = createTextEditorCore(register);
  const first = registration();
  core.addMutationTool(first);

  const observed: string[] = [];
  core.onMutationTool((tool) => {
    observed.push(tool.name);
  });

  expect(register).toHaveBeenCalledWith(first, core);
  expect(core.getMutationTools()).toEqual([first]);
  expect(observed).toEqual(["fixture"]);
  expect(() => core.addMutationTool(registration())).toThrow("already registered");
});

test("commits plugin mutation registrations through the same registry", async () => {
  const core = createTextEditorCore();
  await core.registerPlugin({
    protocol: "pi-agent-text-editor",
    apiVersion: 17,
    id: "fixture-plugin",
    setup(api) {
      api.addMutationTool(registration("plugin-fixture"));
    },
  });

  expect(core.getMutationTools().map(({ name }) => name)).toEqual(["plugin-fixture"]);
});
test("rejects a plugin draft with duplicate mutations without committing either", async () => {
  const core = createTextEditorCore();
  await expect(
    core.registerPlugin({
      protocol: "pi-agent-text-editor",
      apiVersion: 17,
      id: "invalid-plugin",
      setup(api) {
        api.addMutationTool(registration("duplicate"));
        api.addMutationTool(registration("duplicate"));
      },
    }),
  ).rejects.toThrow("already registered");

  expect(core.getMutationTools()).toEqual([]);
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
    apiVersion: 17,
    id: "explicit-renderer",
    setup(api) {
      api.addToolRenderer({ tool: "external-mutation", renderCall: explicitCall });
    },
  });
  await core.registerPlugin({
    protocol: "pi-agent-text-editor",
    apiVersion: 17,
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

function asMutationRegistration(value: unknown): AnyTextMutationToolRegistration {
  return value as AnyTextMutationToolRegistration;
}
