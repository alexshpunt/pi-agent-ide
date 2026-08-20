import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution } from "pi-coding-agent-test";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";

const extensions = createExtensionSet();

describe("pi-agent-text-editor insert", () => {
  test("inserts text after the target line", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "insert.txt", "before\nanchor\nafter\n");
      const relativeFile = path.relative(directory, file);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "text-editor-insert",
        tool: "insert",
        arguments: {
          path: relativeFile,
          anchor: formatLineHashAnchor(2, "anchor"),
          text: "inserted",
        },
      });
      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      expectTextToolDiff(
        scenario,
        relativeFile,
        "before\nanchor\nafter\n",
        "before\nanchor\ninserted\nafter\n",
      );
      await expect(readFile(file, "utf8")).resolves.toBe("before\nanchor\ninserted\nafter\n");
    });
  });
});
