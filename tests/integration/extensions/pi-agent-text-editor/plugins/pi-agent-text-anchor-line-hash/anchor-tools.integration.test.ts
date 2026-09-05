import { readFile } from "node:fs/promises";
import path from "node:path";

import { getToolExecution, getToolResultText } from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createLineHashAnchor } from "#pi-agent-text-anchor-line-hash/src/anchor.js";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";

const extensions = await createExtensionSet();
afterAll(() => extensions.dispose());

const lines = ["alpha", "bravo", "charlie", "delta", "echo"] as const;
const content = lines.join("\n");
const anchor = (lineNumber: number): string =>
  createLineHashAnchor(lineNumber, lines[lineNumber - 1]).value;

describe("line-hash anchors through text editor tools", () => {
  test("inserts after a line-hash anchor", async () => {
    const after = anchor(2);
    await runLineHashScenario(
      "line-hash-insert",
      "insert",
      { anchor: after, text: "inserted" },
      [after],
      ["alpha", "bravo", "inserted", "charlie", "delta", "echo"].join("\n"),
    );
  });

  test("extracts anchors from stable presentation variants", async () => {
    const canonical = anchor(2);
    const variants = [
      { name: "separator", value: `${canonical}|` },
      { name: "file-prefix", value: `insert.txt:${canonical}|` },
      { name: "code-span", value: `use \`${canonical}|\` here` },
      { name: "surrounded", value: `prefix ${canonical} suffix` },
    ] as const;

    for (const variant of variants) {
      await runLineHashScenario(
        `line-hash-extract-${variant.name}`,
        "insert",
        { anchor: variant.value, text: "inserted" },
        [canonical],
        ["alpha", "bravo", "inserted", "charlie", "delta", "echo"].join("\n"),
      );
    }
  });

  test("replaces a line-hash range", async () => {
    const start = anchor(2);
    const end = anchor(3);
    await runLineHashScenario(
      "line-hash-replace",
      "replace",
      { start, end, text: "replaced" },
      [start, end],
      ["alpha", "replaced", "delta", "echo"].join("\n"),
    );
  });

  test("deletes a line-hash range", async () => {
    const start = anchor(2);
    const end = anchor(3);
    await runLineHashScenario(
      "line-hash-delete",
      "delete",
      { start, end },
      [start, end],
      ["alpha", "delta", "echo"].join("\n"),
    );
  });

  test("copies a line-hash range after a line-hash target", async () => {
    const start = anchor(2);
    const end = anchor(3);
    const target = anchor(5);
    await runLineHashScenario(
      "line-hash-copy",
      "copy",
      { start, end, targetStart: target },
      [start, end, target],
      ["alpha", "bravo", "charlie", "delta", "echo", "bravo", "charlie"].join("\n"),
    );
  });

  test("cuts a line-hash range after a line-hash target", async () => {
    const start = anchor(2);
    const end = anchor(3);
    const target = anchor(5);
    await runLineHashScenario(
      "line-hash-move",
      "move",
      { start, end, targetStart: target },
      [start, end, target],
      ["alpha", "delta", "echo", "bravo", "charlie"].join("\n"),
    );
  });
});

async function runLineHashScenario(
  testName: string,
  tool: "insert" | "replace" | "delete" | "copy" | "move",
  arguments_: Record<string, unknown>,
  expectedAnchors: readonly string[],
  expectedContent: string,
): Promise<void> {
  await withTempWorkspace(async (directory) => {
    const file = await createFixture(directory, `${tool}.txt`, content);
    const relativeFile = path.relative(directory, file);
    const toolArguments =
      tool === "copy" || tool === "move"
        ? { path: relativeFile, target: relativeFile, ...arguments_ }
        : { path: relativeFile, ...arguments_ };
    const scenario = await runTextToolScenario({
      extensions: extensions.paths,
      cwd: directory,
      testName,
      tool,
      arguments: toolArguments,
    });
    const { result, mutationCallId, preflightCallIds } = scenario;
    const preflight = preflightCallIds.map((id) => getToolResultText(result, id)).join("\n");

    for (const expectedAnchor of expectedAnchors) {
      expect(preflight).toContain(expectedAnchor);
    }

    expect(getToolExecution(result, mutationCallId).isError).toBe(false);
    expectTextToolDiff(scenario, relativeFile, content, expectedContent);
    const finalState = getToolResultText(result, mutationCallId);
    expect(finalState.split("\n")[0]).toBe(relativeFile);
    expect(finalState).toMatch(/^\d+#[A-Z0-9]{4}\|/mu);
    expect(finalState).not.toMatch(/^[+ -]\|/mu);

    for (const [index, line] of expectedContent.split("\n").entries()) {
      expect(finalState).toContain(`${createLineHashAnchor(index + 1, line).value}|${line}`);
    }
    await expect(readFile(file, "utf8")).resolves.toBe(expectedContent);
  });
}
