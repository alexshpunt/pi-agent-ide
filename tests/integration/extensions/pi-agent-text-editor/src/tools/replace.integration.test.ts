import { readFile } from "node:fs/promises";
import path from "node:path";

import { getToolExecution } from "pi-coding-agent-test";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";
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
      expectTextToolDiff(
        scenario,
        relativeFile,
        "before\nreplace-me\nafter\n",
        "before\nreplaced\nafter\n",
      );
      await expect(readFile(file, "utf8")).resolves.toBe("before\nreplaced\nafter\n");
    });
  });
});
