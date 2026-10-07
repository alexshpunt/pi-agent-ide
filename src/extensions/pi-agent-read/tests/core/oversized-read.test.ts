import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import type { ReadToolResult } from "#src/api/tools/read.js";
import { limitReadOutput } from "#src/core/tools/read/output-truncation.js";
import { createReadTool } from "#src/core/tools/tool-read.js";

function sourceResult(source: string, resolvedBy: string, content: string): ReadToolResult {
  return {
    content: [{ type: "text", text: content }],
    details: { source, resolvedBy, startLine: 7, endLine: 7, totalLines: 7, lines: [] },
    script: { kind: "text", source, content, lines: [], startLine: 7, endLine: 7, totalLines: 7 },
  };
}

test("an oversized local line offers an executable original-byte read without returning partial text", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oversized-read-"));
  const read = createReadTool();
  const source = path.join(cwd, 'quoted " source.txt');
  const content = "é".repeat(30000);
  try {
    await writeFile(source, content);
    const original = sourceResult(source, "filesystem", content);
    const result = await limitReadOutput(original, { path: source, views: ["anchors"] });
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected the oversized-line notice");
    expect(block.text).toBe(
      `[Line 7 is 58.6KB, exceeds the 50.0KB output limit. This line was not returned. Read ${JSON.stringify(`raw:${source}`)} with offset=0 and limit=4096 to inspect the original bytes.]`,
    );
    const action = /Read ("(?:[^"\\]|\\.)*") with offset=(\d+) and limit=(\d+)/u.exec(block.text);
    if (action === null) throw new Error("Missing bounded raw recovery");
    const rawSource: unknown = JSON.parse(action[1] ?? "");
    if (typeof rawSource !== "string") throw new Error("Expected a raw source string");
    const bytes = await read.execute(
      { path: rawSource, offset: Number(action[2]), limit: Number(action[3]) },
      { cwd },
    );
    expect(bytes.isError).not.toBe(true);
    expect(bytes.script).toMatchObject({
      kind: "bytes",
      byteOffset: 0,
      byteLength: 4096,
      totalBytes: 60000,
      bytes: [...Buffer.from(content).subarray(0, 4096)],
    });
    expect(result.script).toBe(original.script);
    expect(result.details.truncation).toMatchObject({
      firstLineExceedsLimit: true,
      outputLines: 0,
    });
    expect(result.details.lines).toEqual([]);
  } finally {
    await read.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an oversized jq value asks for a narrower filter and retains its full saved output", async () => {
  const content = JSON.stringify("y".repeat(60000));
  const base = sourceResult("/data/values.json", "filesystem", content);
  const original = { ...base, details: { ...base.details, startLine: 1 } };
  const saved: string[] = [];
  const result = await limitReadOutput(
    original,
    { path: original.details.source, views: ["jq:.payload"] },
    async (text) => {
      saved.push(text);
      return "temp:saved";
    },
  );
  expect(result.content).toEqual([
    {
      type: "text",
      text: "[Output line 1 is 58.6KB, exceeds the 50.0KB output limit. This line was not returned. Narrow the jq filter to return a smaller value. Full output: temp:saved. Available until this runtime is disposed.]",
    },
  ]);
  expect(saved).toEqual([content]);
  expect(result.script).toBe(original.script);
  expect(result.details.temporarySource).toBe("temp:saved");
  expect(result.details.truncation?.outputLines).toBe(0);
});

test("directory and nonlocal oversized output do not offer an invalid raw file read", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oversized-directory-"));
  try {
    for (const [source, resolvedBy] of [
      [cwd, "filesystem"],
      ["https://example.test/page", "http"],
    ] as const) {
      const result = await limitReadOutput(sourceResult(source, resolvedBy, "x".repeat(60000)), {
        path: source,
        views: resolvedBy === "http" ? ["jq:."] : undefined,
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: "[Line 7 is 58.6KB, exceeds 50.0KB limit. Use a source-specific tool to read this line in smaller byte ranges.]",
        },
      ]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
