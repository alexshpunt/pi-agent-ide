import { readFile } from "node:fs/promises";
import path from "node:path";

import { getToolExecution, getToolExecutionDetails, getToolResultText } from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

const restoreRunner = forceStandaloneIntegrationFile();
const extensions = await createExtensionSet();
afterAll(async () => {
  restoreRunner();
  await extensions.dispose();
});

const content = ["alpha", "bravo", "charlie", "delta", "echo"].join("\n");

describe("exact text anchors through real text editor tools", () => {
  test("replaces one partial-line match", async () => {
    await runExactScenario(
      "exact-replace",
      "replace",
      { start: "rav", text: "XYZ" },
      content.replace("rav", "XYZ"),
    );
  });

  test("preserves the following line when replacing an exact full line", async () => {
    await withTempWorkspace(async (directory) => {
      const releasePrefix = ["scripts", "release"].join("/");
      const policyFixture = [
        "const privatePrefixes = [",
        '  ".agents/",',
        '  ".pi/",',
        '  ".vscode/",',
        '  "dev/",',
        `  "${releasePrefix}/",`,
        '  "tests/release/",',
        "];",
        'const privateFiles = new Set(["CONTEXT.md", "lefthook.yml"]);',
        "const publicRoots = new Set([",
        '  ".github",',
        '  "assets",',
        '  "docs",',
        '  "packages",',
        '  "scripts",',
        '  "src",',
        '  "tests",',
        '  "tools",',
        "]);",
      ].join("\n");
      const replacement =
        'const privateFiles = new Set(["AGENTS.md", "CONTEXT.md", "lefthook.yml"]);';
      const file = await createFixture(directory, "policy.ts", policyFixture);
      const relativeFile = path.relative(directory, file);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "exact-full-line-replace-preserves-following-line",
        tool: "replace",
        arguments: {
          path: relativeFile,
          start: 'const privateFiles = new Set(["CONTEXT.md", "lefthook.yml"]);',
          text: replacement,
        },
      });
      const expectedContent = policyFixture.replace(
        'const privateFiles = new Set(["CONTEXT.md", "lefthook.yml"]);',
        replacement,
      );

      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe(expectedContent);
      const rendered = getToolResultText(scenario.result, scenario.mutationCallId);
      const renderedLines = rendered.split("\n");
      expect(renderedLines[0]).toBe(relativeFile);
      expect(renderedLines).toContain(replacement);
      expect(rendered).not.toMatch(/^[+ -]\|/mu);
      expect(rendered).not.toMatch(/^\d+#[A-Z0-9]{4}\|/mu);

      expect(rendered).not.toContain("scope-begin-");
      expect(rendered).not.toContain("scope-end-");
      expect(renderedLines.some((line) => line.includes("const publicRoots = new Set(["))).toBe(
        true,
      );
      expect(renderedLines.some((line) => line.includes(`${replacement}const publicRoots`))).toBe(
        false,
      );
    });
  });

  test("mixes an exact start with a line-hash end", async () => {
    await runExactScenario(
      "exact-line-range",
      "replace",
      { start: "rav", end: formatLineHashAnchor(3, "charlie"), text: "X" },
      ["alpha", "bX", "delta", "echo"].join("\n"),
    );
  });

  test("inserts at the end of one exact match", async () => {
    await runExactScenario(
      "exact-insert",
      "insert",
      { anchor: "bravo", text: "!" },
      ["alpha", "bravo", "!", "charlie", "delta", "echo"].join("\n"),
    );
  });

  test("deletes only one exact match", async () => {
    await runExactScenario("exact-delete", "delete", { start: "rav" }, content.replace("rav", ""));
  });

  test("deletes complete matched lines without leaving a gap", async () => {
    await runExactScenario(
      "exact-delete-lines",
      "delete",
      { start: "bravo\ncharlie" },
      ["alpha", "delta", "echo"].join("\n"),
    );
  });

  test("copies one exact match after another", async () => {
    await runExactScenario(
      "exact-copy",
      "copy",
      { start: "bravo", targetStart: "delta" },
      ["alpha", "bravo", "charlie", "delta", "bravo", "echo"].join("\n"),
    );
  });

  test("moves one exact match after another", async () => {
    await runExactScenario(
      "exact-move",
      "move",
      { start: "bravo", targetStart: "delta" },
      ["alpha", "charlie", "delta", "bravo", "echo"].join("\n"),
    );
  });

  test("blocks ambiguous exact text and returns fresh primary anchors", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "ambiguous.txt", content);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "exact-ambiguous-recovery",
        tool: "replace",
        arguments: { path: "ambiguous.txt", start: "a", text: "blocked" },
      });
      const execution = getToolExecution(scenario.result, scenario.mutationCallId);
      expect(execution.isError).toBe(true);
      const resultText = getToolResultText(scenario.result, scenario.mutationCallId);
      expect(resultText).toContain('anchor "a" is ambiguous');
      expect(resultText).not.toContain("is stale");
      expect(resultText).toMatch(/\d+#[A-F0-9]{4}\|/u);
      expect(getToolExecutionDetails(execution)).toHaveProperty("anchorRecoveries.0.total", 5);
      await expect(readFile(file, "utf8")).resolves.toBe(content);
    });
  });

  test("reports missing exact text without calling it stale", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "missing.txt", content);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "exact-missing-recovery",
        tool: "replace",
        arguments: { path: "missing.txt", start: "charle", text: "blocked" },
      });
      const execution = getToolExecution(scenario.result, scenario.mutationCallId);
      expect(execution.isError).toBe(true);
      const resultText = getToolResultText(scenario.result, scenario.mutationCallId);
      expect(resultText).toContain('anchor "charle" was not found');
      expect(resultText).not.toContain("is stale");
      expect(resultText).toMatch(/\d+#[A-F0-9]{4}\|charlie/u);
      await expect(readFile(file, "utf8")).resolves.toBe(content);
    });
  });

  test("reports every failed anchor field before copy mutation", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "multiple-failures.txt", content);
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "exact-multiple-failures",
        tool: "copy",
        arguments: {
          path: "multiple-failures.txt",
          start: "a",
          target: "multiple-failures.txt",
          targetStart: "charle",
        },
      });
      const execution = getToolExecution(scenario.result, scenario.mutationCallId);
      expect(execution.isError).toBe(true);
      const detailsText = JSON.stringify(getToolExecutionDetails(execution));
      expect(detailsText).toContain('"field":"start"');
      expect(detailsText).toContain('"field":"targetStart"');
      await expect(readFile(file, "utf8")).resolves.toBe(content);
    });
  });

  test("normalizes cross-file copied text to the target EOL", async () => {
    await withTempWorkspace(async (directory) => {
      const source = await createFixture(directory, "source.txt", "alpha\nbravo");
      const target = await createFixture(directory, "target.txt", "one\r\ntwo");
      const scenario = await runTextToolScenario({
        extensions: extensions.paths,
        cwd: directory,
        testName: "exact-copy-crlf",
        tool: "copy",
        arguments: {
          path: "source.txt",
          start: "alpha\nbravo",
          target: "target.txt",
          targetStart: "one",
        },
      });
      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      await expect(readFile(target, "utf8")).resolves.toBe("one\r\nalpha\r\nbravo\r\ntwo");
      await expect(readFile(source, "utf8")).resolves.toBe("alpha\nbravo");
    });
  });
});

async function runExactScenario(
  testName: string,
  tool: "insert" | "replace" | "delete" | "copy" | "move",
  arguments_: Record<string, unknown>,
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
    const { result, mutationCallId } = scenario;

    expect(getToolExecution(result, mutationCallId).isError).toBe(false);
    expectTextToolDiff(scenario, relativeFile, content, expectedContent);
    await expect(readFile(file, "utf8")).resolves.toBe(expectedContent);
  });
}
