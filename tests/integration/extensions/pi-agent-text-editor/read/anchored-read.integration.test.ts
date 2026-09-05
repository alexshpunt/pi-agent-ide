import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

const anchoredExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-text-editor/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-exact/index.ts",
]);
afterAll(() => anchoredExtensions.dispose());

const tempRoot = path.resolve(".agents/tmp/pi-agent-text-editor");
const toolId = "read";
const fixtureLines = ["alpha intro", "bravo marker", "charlie note", "bravo repeat", "delta tail"];

test("starts reading at an exact text anchor", async () => {
  await withTempDirectory(async (directory) => {
    await writeFixture(directory);
    const result = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-exact",
      calls: [{ id: "anchored", path: "notes.md#charlie note" }],
    });

    const details = getToolResultMessage<ReadResultDetails>(result, "anchored").details;
    expect(details.startLine).toBe(3);
    expect(details.endLine).toBe(5);
    expect(getToolResultText(result, "anchored")).toContain("charlie note");
  });
});

test("treats zero as an alias for the default offset on a returned anchor", async () => {
  await withTempDirectory(async (directory) => {
    await writeFixture(directory);
    const source = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-returned-anchor-source",
      calls: [{ id: "source", path: "notes.md", views: ["anchors"] }],
    });

    const anchorMatch = getToolResultText(source, "source").match(
      /\b([1-9]\d*#[A-Z0-9]{3,4})\|charlie note/u,
    );
    const anchor = anchorMatch?.[1];
    if (anchor === undefined) {
      throw new Error("Expected a complete line-hash anchor in the read result");
    }
    expect(anchor).toBe(formatLineHashAnchor(3, fixtureLines[2]));

    const result = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-zero-alias",
      calls: [
        { id: "omitted", path: `notes.md#${anchor}`, limit: 1 },
        { id: "zero", path: `notes.md#${anchor}`, offset: 0, limit: 1 },
        { id: "one", path: `notes.md#${anchor}`, offset: 1, limit: 1 },
        { id: "negative", path: `notes.md#${anchor}`, offset: -1, limit: 1 },
        { id: "positive", path: `notes.md#${anchor}`, offset: 2, limit: 1 },
      ],
    });

    expect(getToolResultMessage<ReadResultDetails>(result, "omitted").details.startLine).toBe(3);
    expect(getToolResultMessage<ReadResultDetails>(result, "zero").details.startLine).toBe(3);
    expect(getToolResultMessage<ReadResultDetails>(result, "one").details.startLine).toBe(3);
    expect(getToolResultMessage<ReadResultDetails>(result, "negative").details.startLine).toBe(2);
    expect(getToolResultMessage<ReadResultDetails>(result, "positive").details.startLine).toBe(4);
    expect(getToolResultText(result, "zero")).toBe(getToolResultText(result, "omitted"));
    expect(getToolResultText(result, "zero")).toBe(getToolResultText(result, "one"));
    expect(getToolResultText(result, "zero")).toContain("charlie note");
    expect(getToolResultText(result, "zero")).not.toContain("bravo marker");
  });
});

test("counts offsets from the anchor while keeping absolute numbering", async () => {
  await withTempDirectory(async (directory) => {
    await writeFixture(directory);
    const result = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-offset",
      calls: [{ id: "windowed", path: "notes.md#charlie note", offset: -2, limit: 3 }],
    });

    const details = getToolResultMessage<ReadResultDetails>(result, "windowed").details;
    expect(details.startLine).toBe(1);
    expect(details.endLine).toBe(3);
    expect(getToolResultText(result, "windowed")).toContain("alpha intro");
  });
});

test("accepts a line-hash anchor value", async () => {
  await withTempDirectory(async (directory) => {
    await writeFixture(directory);
    const anchor = formatLineHashAnchor(2, fixtureLines[1]);
    const result = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-line-hash",
      calls: [{ id: "hashed", path: `notes.md#${anchor}` }],
    });

    const details = getToolResultMessage<ReadResultDetails>(result, "hashed").details;
    expect(details.startLine).toBe(2);
  });
});

test("rejects an ambiguous anchor with candidate lines", async () => {
  await withTempDirectory(async (directory) => {
    await writeFixture(directory);
    const result = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-ambiguous",
      calls: [{ id: "ambiguous", path: "notes.md#bravo" }],
    });

    expect(getToolResultMessage(result, "ambiguous").isError).toBe(true);
    const failureText = getToolResultText(result, "ambiguous");
    expect(failureText).toContain("Candidate: line 2");
    expect(failureText).toContain("Candidate: line 4");
  });
});

test("reads a file whose name contains # as a whole", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "weird#name.md"), fixtureLines.join("\n"), "utf8");
    const result = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-hash-filename",
      calls: [{ id: "whole", path: "weird#name.md" }],
    });

    const details = getToolResultMessage<ReadResultDetails>(result, "whole").details;
    expect(details.startLine).toBe(1);
    expect(details.totalLines).toBe(fixtureLines.length);
  });
});

test("continuation hints stay valid for the same anchored source", async () => {
  await withTempDirectory(async (directory) => {
    await writeFixture(directory);
    const first = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-hint-first",
      calls: [{ id: "first", path: "notes.md#bravo marker", limit: 1 }],
    });

    const firstDetails = getToolResultMessage<ReadResultDetails>(first, "first").details;
    expect(firstDetails.startLine).toBe(2);
    expect(getToolResultText(first, "first")).toContain("Use offset=2 to continue.");

    const second = await runReadCalls({
      cwd: directory,
      testName: "anchored-read-hint-second",
      calls: [{ id: "second", path: "notes.md#bravo marker", offset: 2, limit: 2 }],
    });

    const secondDetails = getToolResultMessage<ReadResultDetails>(second, "second").details;
    expect(secondDetails.startLine).toBe(3);
    expect(secondDetails.endLine).toBe(4);
  });
});

async function writeFixture(directory: string): Promise<void> {
  await writeFile(path.join(directory, "notes.md"), fixtureLines.join("\n"), "utf8");
}

function runReadCalls(options: {
  readonly calls: readonly {
    readonly id: string;
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly views?: readonly string[];
  }[];
  readonly cwd: string;
  readonly extensions?: readonly string[];
  readonly testName: string;
}): Promise<PiIntegrationTestResult> {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: options.testName,
    cwd: options.cwd,
    extensions: options.extensions ?? anchoredExtensions.paths,
    tools: [toolId],
    conversation: [
      assistantMessage(
        options.calls.map((call) =>
          toolCall({
            id: call.id,
            name: toolId,
            arguments: {
              path: call.path,
              ...(call.offset === undefined ? {} : { offset: call.offset }),
              ...(call.limit === undefined ? {} : { limit: call.limit }),
              ...(call.views === undefined ? {} : { views: call.views }),
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
  const directory = await mkdtemp(path.join(tempRoot, "anchored-read-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
