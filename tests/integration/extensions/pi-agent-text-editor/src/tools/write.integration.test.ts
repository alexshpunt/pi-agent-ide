import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  getToolCallNames,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  getTextToolMutationData,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";

const extensions = await createExtensionSet();
afterAll(() => extensions.dispose());

describe("pi-agent-text-editor tools", () => {
  test("registers the text tools and writes a file", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "write.txt", "before\n");
      const relativeFile = path.relative(directory, file);
      const tools = ["write", "replace", "insert", "delete", "copy", "move", "read"] as const;
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "text-editor-write",
        tool: "write",
        tools,
        arguments: { path: relativeFile, content: "after\n" },
      });
      const { result, mutationCallId } = scenario;

      expect(getToolCallNames(result).filter((name) => name !== "read")).toEqual(["write"]);
      expect(
        result.traceEvents.find((event) => event.type === "tools_configured")?.activeTools,
      ).toEqual(tools);
      expect(getToolExecution(result, mutationCallId).isError).toBe(false);
      const receipt = getToolResultText(result, mutationCallId);
      expect(receipt).toContain("Saved file.");
      expect(receipt).not.toContain("after\n");
      expect(
        getTextToolMutationData(getToolExecutionDetails(getToolExecution(result, mutationCallId))),
      ).toMatchObject({
        addedLines: 1,
        removedLines: 1,
        beforeContentMap: { [relativeFile]: "before\n" },
        afterContent: "after\n",
      });
      expect(result.tuiRenderedOutput).toContain("after");
      for (const id of scenario.postflightCallIds)
        expect(getToolResultText(result, id)).toContain("after");
      await expect(readFile(file, "utf8")).resolves.toBe("after\n");
    });
  });
});
