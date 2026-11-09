import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution } from "pi-coding-agent-test";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { runTextToolScenario } from "#integration/support/pi-runtime/scenario.ts";

const extensions = createExtensionSet();

describe("pi-agent-text-editor move", () => {
  test("moves a selected range from the source file into a different target file", async () => {
    await withTempWorkspace(async (directory) => {
      const source = await createFixture(
        directory,
        "source.txt",
        "source-one\nmove-me\nsource-end\n",
      );
      const target = await createFixture(directory, "target.txt", "target-start\ntarget-end\n");
      const sourcePath = path.relative(directory, source);
      const targetPath = path.relative(directory, target);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "text-editor-move-cross-file",
        tool: "move",
        arguments: {
          path: sourcePath,
          start: formatLineHashAnchor("source-one\nmove-me\nsource-end\n", 2),
          target: targetPath,
          targetStart: formatLineHashAnchor("target-start\ntarget-end\n", 1),
        },
      });

      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      await expect(readFile(source, "utf8")).resolves.toBe("source-one\nsource-end\n");
      await expect(readFile(target, "utf8")).resolves.toBe("target-start\nmove-me\ntarget-end\n");
    });
  });
  test("moves a selected range inside the same file", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "same-file-move.txt", "first\nmove-me\nlast\n");
      const relativeFile = path.relative(directory, file);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "text-editor-move-same-file",
        tool: "move",
        arguments: {
          path: relativeFile,
          start: formatLineHashAnchor("first\nmove-me\nlast\n", 2),
          target: relativeFile,
          targetStart: formatLineHashAnchor("first\nmove-me\nlast\n", 3),
        },
      });

      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe("first\nlast\nmove-me\n");
    });
  });
});
