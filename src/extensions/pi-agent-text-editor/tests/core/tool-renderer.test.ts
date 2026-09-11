import { Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

test("a conditional tool renderer preserves the existing renderer for unmatched resources", async () => {
  const core = createTextEditorCore();
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "default-renderer",
    setup(api) {
      api.addToolRenderer({
        tool: "write",
        renderCall: () => new Text("file", 0, 0),
      });
    },
  });
  await core.registerPlugin({
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "terminal-renderer",
    setup(api) {
      api.addToolRenderer({
        tool: "write",
        matches: (value) =>
          typeof value === "object" &&
          value !== null &&
          "path" in value &&
          typeof value.path === "string" &&
          value.path.startsWith("shell:"),
        renderCall: () => new Text("terminal", 0, 0),
      });
    },
  });

  const render = core.getToolRenderer("write")?.renderCall;
  expect(
    render?.({ path: "notes.txt" }, {} as never, {} as never)
      .render(80)
      .map((row) => row.trimEnd()),
  ).toEqual(["file"]);
  expect(
    render?.({ path: "shell:abcdef123456" }, {} as never, {} as never)
      .render(80)
      .map((row) => row.trimEnd()),
  ).toEqual(["terminal"]);
});
