import { expect, test } from "vitest";
import type { ReadFailure } from "#src/api/tools/read.js";
import { failureResult } from "#src/core/tools/read/read-result.js";
import { createReadTool } from "#src/core/tools/tool-read.js";

function resultText(failure: ReadFailure): string {
  const result = failureResult(failure);
  expect(result.isError).toBe(true);
  expect(result.details.failure).toBe(failure);
  expect(result.script).toBeUndefined();
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected a readable failure");
  return block.text;
}

test("a failed source shows its calling error, not the chain of internal resolvers", () => {
  const cause = new Error("Use symbol:<file>#<selector> to choose one declaration");
  const wrapped = new Error("Text anchor resource resolver internal failed", { cause });
  const failure: ReadFailure = {
    code: "RESOLVE_FAILED",
    source: "symbol:notes.ts",
    resolverId: "internal",
    message: "Text target resolver internal failed",
    cause: wrapped,
  };
  const text = resultText(failure);
  expect(text).toContain('Read failed for "symbol:notes.ts"');
  expect(text).toContain(cause.message);
  expect(text).not.toContain("internal");
  expect(text).not.toContain("RESOLVE_FAILED");
  expect(failure.cause).toBe(wrapped);
});

test("missing-file hints stay optional and permissions do not invent a retry", () => {
  const missing: ReadFailure = {
    code: "READ_FAILED",
    source: "notes.txt",
    message: "Unable to read notes.txt",
    cause: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
  };
  expect(resultText(missing)).toContain(JSON.stringify("notes.txt"));
  expect(resultText(missing)).toContain("Source not found");
  expect(resultText(missing)).not.toContain("ENOENT");
  const hinted = resultText({ ...missing, candidates: [{ path: "note.txt" }] });
  expect(hinted).toContain('- "note.txt"');
  expect(resultText(missing)).not.toContain(JSON.stringify("note.txt"));
  const denied = resultText({
    ...missing,
    cause: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
  });
  expect(denied).toContain(JSON.stringify("notes.txt"));
  expect(denied).toContain("Access denied");
  expect(denied).not.toContain("Source not found");
  expect(denied).not.toContain("EACCES");
  expect(denied).not.toContain(JSON.stringify("note.txt"));
});

test("anchor recovery names the actual source while preserving a stale-line candidate", () => {
  const text = resultText({
    code: "FRAGMENT_FAILED",
    source: '/workspace/quoted"notes.txt',
    message: "line hash anchor is stale\nCandidate: line 2",
  });
  expect(text).toContain("line hash anchor is stale\nCandidate: line 2");
  expect(text).toContain(JSON.stringify('/workspace/quoted"notes.txt'));
  expect(text).toContain('views=["anchors"]');
  expect(text).not.toContain("FRAGMENT_FAILED");
});

test("missing input gives a valid next call without changing the rejection", async () => {
  const read = createReadTool();
  try {
    const result = await read.execute({}, { cwd: "/workspace" });
    expect(result.isError).toBe(true);
    expect(result.details.failure?.code).toBe("INVALID_REQUEST");
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected missing-source failure");
    expect(result.details.failure?.source).toBeUndefined();
    expect(block.text).toContain("path");
    expect(block.text).not.toContain("INVALID_REQUEST");
    expect(result.script).toBeUndefined();
  } finally {
    await read.dispose();
  }
});

test("unknown backend errors keep their actual reason without fabricated recovery", () => {
  const reason = "Provider failed while decoding the response";
  const text = resultText({
    code: "READ_FAILED",
    source: "memory:notes",
    message: "Unable to read memory:notes",
    cause: new Error(reason),
  });
  expect(text).toContain(reason);
  expect(text).not.toContain("Retry");
  expect(text).not.toContain("Search");
});
