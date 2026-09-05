import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { restoreReadDetails } from "#src/extensions/pi-agent-read/src/core/tools/read/persisted-result.js";

import {
  formatLineHashAnchor,
  renderLineHashLines,
} from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  type PiIntegrationTestResult,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import type { ReadResultDetails } from "pi-agent-read/api/tools/read";
import { generateReadExtensions } from "pi-agent-read/testing";

const textHashExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/read/support/other-text-resolver-extension.ts",
]);
afterAll(() => textHashExtensions.dispose());

const tempRoot = path.resolve(".tmp/pi-agent-text-editor");
const toolId = "read";
const fixtureLines = [
  "# Hash Anchor Field Notes",
  "",
  "This file exercises the independently loaded read processor.",
  "The filesystem resolver owns the only source read in this pipeline.",
  "",
  "## Morning",
  "",
  "The original observation remains stable for the first invocation.",
  "A neighboring line gives the range projection useful context.",
  "Blank lines stay part of the decoded text snapshot.",
  "",
  "## Afternoon",
  "",
  "The processor receives complete text before core applies a range.",
  "Every accepted anchor keeps its original source line number.",
  "The core renders accepted metadata for the agent-facing result.",
  "",
  "## Summary",
  "",
  "Resolver selection and text processing remain independent concerns.",
];
const changedFixtureLines = fixtureLines.map((line, index) =>
  index === 7 ? "The changed observation produces a different content-derived anchor." : line,
);

test("adds hash anchors to filesystem text", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "original.md"), fixtureLines.join("\n"), "utf8");
    await writeFile(path.join(directory, "changed.md"), changedFixtureLines.join("\n"), "utf8");

    const result = await runReadCalls({
      cwd: directory,
      extensions: textHashExtensions.paths,
      testName: "read-text-hash-anchor",
      calls: [
        { id: "read-original", path: "original.md" },
        { id: "read-changed", path: "changed.md" },
      ],
    });
    const original = getToolResultMessage<ReadResultDetails>(result, "read-original");
    const originalText = getToolResultText(result, "read-original");
    const changedText = getToolResultText(result, "read-changed");
    const originalAnchor = formatLineHashAnchor(8, fixtureLines[7]);
    const changedAnchor = formatLineHashAnchor(8, changedFixtureLines[7]);

    expect(originalText).toBe(renderLineHashLines(fixtureLines).join("\n"));
    expect(changedText).toBe(renderLineHashLines(changedFixtureLines).join("\n"));
    expect(originalAnchor).not.toBe(changedAnchor);
    expect(originalText).toContain(`${originalAnchor}|${fixtureLines[7]}`);
    expect(changedText).toContain(`${changedAnchor}|${changedFixtureLines[7]}`);

    const firstLine = restoreReadDetails(original.details as ReadResultDetails, originalText)
      .lines?.[0];
    expect(firstLine).toMatchObject({ lineNumber: 1, content: fixtureLines[0] });
  });
});

test("keeps original anchors when projecting a range", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "range.md"), fixtureLines.join("\n"), "utf8");

    const result = await runReadCalls({
      cwd: directory,
      extensions: textHashExtensions.paths,
      testName: "read-text-hash-anchor-range",
      calls: [{ id: "read-range", path: "range.md", offset: 7, limit: 3 }],
    });
    const read = getToolResultMessage<ReadResultDetails>(result, "read-range");
    const selectedLines = fixtureLines.slice(6, 9);

    expect(getToolResultText(result, "read-range")).toContain(
      renderLineHashLines(fixtureLines, 7, 9).join("\n"),
    );
    expect(
      restoreReadDetails(
        read.details as ReadResultDetails,
        getToolResultText(result, "read-range"),
      ),
    ).toMatchObject({
      startLine: 7,
      endLine: 9,
      totalLines: fixtureLines.length,
      lines: selectedLines.map((content, index) => ({
        lineNumber: index + 7,
        content,
      })),
    });
  });
});

test("does not process text resolved by another plugin", async () => {
  await withTempDirectory(async (directory) => {
    const source = fixtureLines.join("\n");
    await writeFile(path.join(directory, "other.txt"), source, "utf8");

    const result = await runReadCalls({
      cwd: directory,
      extensions: textHashExtensions.paths,
      testName: "read-text-hash-anchor-other-resolver",
      calls: [{ id: "read-other", path: "other:other.txt" }],
    });
    const read = getToolResultMessage<ReadResultDetails>(result, "read-other");
    const lines = restoreReadDetails(
      read.details as ReadResultDetails,
      getToolResultText(result, "read-other"),
    ).lines;

    expect(getToolResultText(result, "read-other")).toBe(source);
    expect(lines?.every((line) => line.anchor === undefined)).toBe(true);
  });
});

async function runReadCalls(options: {
  readonly calls: readonly {
    readonly id: string;
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
  }[];
  readonly cwd: string;
  readonly extensions: readonly string[];
  readonly testName: string;
}): Promise<PiIntegrationTestResult> {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: options.testName,
    cwd: options.cwd,
    extensions: options.extensions,
    tools: [toolId],
    conversation: [
      assistantMessage(
        options.calls.map((call) =>
          toolCall({
            id: call.id,
            name: toolId,
            arguments: {
              path: call.path,
              views: ["anchors"],
              ...(call.offset === undefined ? {} : { offset: call.offset }),
              ...(call.limit === undefined ? {} : { limit: call.limit }),
            },
          }),
        ),
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("The read calls finished")]),
    ],
  }).run("Read the requested sources");
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "text-hash-anchor-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
