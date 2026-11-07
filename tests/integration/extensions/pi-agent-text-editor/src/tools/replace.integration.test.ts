import { readFile } from "node:fs/promises";
import path from "node:path";

import { getToolExecution, getToolResultText } from "pi-coding-agent-test";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { runTextToolScenario } from "#integration/support/pi-runtime/scenario.js";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

const extensions = createExtensionSet();

describe("pi-agent-text-editor replace", () => {
  test("replaces the selected line", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "replace.txt", "before\nreplace-me\nafter\n");
      const relativeFile = path.relative(directory, file);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "text-editor-replace",
        tool: "replace",
        arguments: {
          path: relativeFile,
          start: formatLineHashAnchor(2, "replace-me"),
          text: "replaced",
        },
      });
      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe("before\nreplaced\nafter\n");
    });
  });

  test("shows the same fresh anchors as Read around a LINE#HASH edit", async () => {
    await withTempWorkspace(async (directory) => {
      const lines = Array.from({ length: 1200 }, (_, index) => `value ${index + 1}`);
      const file = await createFixture(directory, "large.txt", `${lines.join("\n")}\n`);
      const relativeFile = path.relative(directory, file);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "text-editor-replace-fresh-anchors",
        tool: "replace",
        arguments: {
          path: relativeFile,
          start: formatLineHashAnchor(600, "value 600"),
          text: "changed 600",
        },
      });
      const edited = getToolResultText(scenario.result, scenario.mutationCallId).split("\n");
      const read = scenario.postflightCallIds
        .map((id) => getToolResultText(scenario.result, id))
        .join("\n")
        .split("\n");
      const header = edited.indexOf("Final text, lines 595–605:");
      const shown = edited.slice(header + 1, header + 12);

      expect(header).toBeGreaterThan(-1);
      expect(shown).toContain(` ${formatLineHashAnchor(600, "changed 600")}|changed 600`);
      for (const row of shown) expect(read).toContain(row);
      expect(edited.filter((row) => /^\s*\d+#[0-9A-F]{4}\|/u.test(row))).toHaveLength(11);
    });
  });
});
