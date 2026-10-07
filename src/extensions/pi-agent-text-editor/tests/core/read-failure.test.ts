import { expect, test, vi } from "vitest";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

test.each(["inspect", "preview", "editText", "editTexts"] as const)(
  "%s reports the read failure cause without running mutations",
  async (route) => {
    const core = createTextEditorCore();
    const cause = new Error("fixture read denied: EACCES");
    const write = vi.fn();
    const operation = vi.fn(() => ({ changes: new Map(), result: undefined }));
    await core.registerPlugin({
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "read-failure",
      setup(api) {
        api.addResolver({
          resolver: {
            id: "fixture",
            async tryResolve(source) {
              return {
                kind: "resolved",
                resource: {
                  source,
                  async read() {
                    throw cause;
                  },
                  write,
                },
              };
            },
          },
        });
      },
    });

    const context = { cwd: "/workspace" };
    const sources = [{ source: "notes.md", read: true }];
    let message: string;
    if (route === "inspect") {
      const outcome = await core.inspectTextAnchors({
        ...context,
        source: "notes.md",
        anchors: ["anchor"],
        kinds: [["fixture"]],
      });
      if (outcome.kind !== "failed") throw new Error("Inspection unexpectedly succeeded");
      expect(outcome.cause).toBe(cause);
      message = outcome.reason;
    } else if (route === "preview") {
      const outcome = await core.previewTexts(sources, context, operation);
      if (outcome.kind !== "failed") throw new Error("Preview unexpectedly succeeded");
      message = outcome.reason;
    } else {
      const outcome =
        route === "editText"
          ? await core.editText("notes.md", context, () => {
              operation();
              return { text: "NEW", result: undefined };
            })
          : await core.editTexts(sources, context, operation);
      if (outcome.kind !== "failed") throw new Error("Edit unexpectedly succeeded");
      expect(outcome.failure.code).toBe("READ_FAILED");
      expect(outcome.failure.cause).toBe(cause);
      message = outcome.failure.message;
    }
    expect(message).toContain(cause.message);
    expect(message).not.toContain("\n");
    expect(operation).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);
