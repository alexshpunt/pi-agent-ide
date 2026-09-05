import { expect, test } from "vitest";

import { recoverExactText } from "#src/recovery.js";
import { DEFAULT_EXACT_TEXT_RECOVERY_CONFIG } from "#src/config.js";

function context(content: string, code: "missing" | "ambiguous") {
  return {
    source: "fixture.ts",
    content,
    lines: content.split("\n"),
    cwd: "/project",
    rejection: { code, reason: "rejected" },
  } as const;
}

test("returns every allowed exact candidate for ambiguity", async () => {
  const result = await recoverExactText(
    "const value",
    context("const value = 1;\nconst value = 2;", "ambiguous"),
    DEFAULT_EXACT_TEXT_RECOVERY_CONFIG,
  );
  expect(result).toMatchObject({ kind: "candidates", total: 2 });
  if (result.kind !== "candidates") {
    throw new Error("Expected candidates");
  }
  expect(result.candidates.map(({ range }) => range.start.lineNumber)).toEqual([1, 2]);
});

test("finds a conservative fuzzy source block without exposing scores", async () => {
  const content = [
    "export function alpha() {",
    "  return callService(request);",
    "}",
    "",
    "export function unrelated() {",
    "  return false;",
    "}",
  ].join("\n");
  const result = await recoverExactText(
    "export function alpha() {\n  return callServce(request);\n}",
    context(content, "missing"),
    DEFAULT_EXACT_TEXT_RECOVERY_CONFIG,
  );
  expect(result.kind).toBe("candidates");
  if (result.kind !== "candidates") {
    throw new Error("Expected candidates");
  }
  const first = result.candidates[0];
  if (first === undefined) {
    throw new Error("Expected one fuzzy candidate");
  }
  expect(first.range).toEqual({
    start: { lineNumber: 1, column: 0 },
    end: { lineNumber: 3, column: 1 },
  });
  expect(first).not.toHaveProperty("score");
});

test("does not fuzzy recover whitespace-only or very short anchors", async () => {
  await expect(
    recoverExactText("   ", context("some content", "missing"), DEFAULT_EXACT_TEXT_RECOVERY_CONFIG),
  ).resolves.toEqual({ kind: "unavailable" });
  await expect(
    recoverExactText("abc", context("abd", "missing"), DEFAULT_EXACT_TEXT_RECOVERY_CONFIG),
  ).resolves.toEqual({ kind: "unavailable" });
});

test("recovers a block whose formatter expanded one line into several lines", async () => {
  const query = String.raw`function parseDotEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\\n").replace(/\\r/g, "\\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\\s+#.*$/, "");
}`;
  const formatted = String.raw`function parseDotEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\\n")
      .replace(/\\r/g, "\\r")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\\s+#.*$/, "");
}`;
  const result = await recoverExactText(query, context(formatted, "missing"), {
    ...DEFAULT_EXACT_TEXT_RECOVERY_CONFIG,
    fuzzyCandidateLimit: 10,
  });
  expect(result.kind).toBe("candidates");
  if (result.kind !== "candidates") {
    throw new Error("Expected a formatting-tolerant candidate");
  }
  expect(result.candidates[0]?.range).toEqual({
    start: { lineNumber: 1, column: 0 },
    end: { lineNumber: 12, column: 1 },
  });
});

test("terminates fuzzy search after the configured search budget", async () => {
  const content = Array.from({ length: 20_000 }, (_, index) => `candidate line ${index}`).join(
    "\n",
  );
  const result = await recoverExactText("candidate changed line", context(content, "missing"), {
    ...DEFAULT_EXACT_TEXT_RECOVERY_CONFIG,
    timeoutMs: 1,
  });
  expect(result).toEqual({ kind: "timed-out" });
});
