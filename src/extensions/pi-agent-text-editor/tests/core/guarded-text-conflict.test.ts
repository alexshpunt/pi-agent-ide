import { expect, test } from "vitest";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

// The real-Pi parity eval also exercises this race with an actual external file writer.
test("guarded text batches reread every approved participant before their first write", async () => {
  const core = createTextEditorCore();
  const values = new Map([
    ["first.txt", "first café"],
    ["second.txt", "second café"],
  ]);
  const writes: string[] = [];
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "external-writer",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "text-files",
          async tryResolve(source) {
            if (!values.has(source)) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: values.get(source) ?? "" }];
                },
                async write(content) {
                  writes.push(source);
                  values.set(source, content[0].type === "text" ? content[0].text : "");
                },
              },
            };
          },
        },
      });
      api.addMutationGuard({
        id: "race",
        guard() {
          values.set("second.txt", "external café preserved");
          return { kind: "accepted" };
        },
      });
    },
  });
  const outcome = await core.editTexts(
    [...values.keys()].map((source) => ({ source, read: true })),
    { cwd: "/workspace" },
    (texts) => ({
      changes: new Map(
        [...texts].map(([source, text]) => [
          source,
          [{ from: 0, to: text.length, insert: "after" }],
        ]),
      ),
      result: undefined,
    }),
  );
  expect(outcome).toMatchObject({
    kind: "failed",
    failure: { code: "CONFLICT", source: "second.txt" },
    completed: [],
  });
  expect(writes).toEqual([]);
  expect(values.get("first.txt")).toBe("first café");
  expect(values.get("second.txt")).toBe("external café preserved");
});
