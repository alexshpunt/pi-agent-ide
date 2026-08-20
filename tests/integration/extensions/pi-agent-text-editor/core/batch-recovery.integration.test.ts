import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  type ChunkSpec,
  getToolCallNames,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const staleAnchorExtension = path.join(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.ts",
);
afterAll(() => extensions.dispose());

function call(name: string, id: string, arguments_: Record<string, unknown>) {
  return toolCall({ id, name, arguments: arguments_ });
}

function batchId(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || !("agenticIdeBatch" in details)) {
    return undefined;
  }

  const batch = details.agenticIdeBatch;
  return typeof batch === "object" &&
    batch !== null &&
    "batchId" in batch &&
    typeof batch.batchId === "string"
    ? batch.batchId
    : undefined;
}

describe("pi-agent-text-editor batch recovery", () => {
  test("resolves every same-file anchor against the original file", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "original-anchors.txt");
      await writeFile(file, ["line-01", "line-02", "line-03", "line-04"].join("\n"), "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-original-anchor-transaction",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["insert"],
        conversation: [
          assistantMessage(
            [
              call("insert", "insert-first", {
                path: "original-anchors.txt",
                anchor: formatLineHashAnchor(1, "line-01"),
                text: "NORMAL-INSERT-1",
              }),
              call("insert", "insert-second", {
                path: "original-anchors.txt",
                anchor: formatLineHashAnchor(3, "line-03"),
                text: "NORMAL-INSERT-2",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Apply both inserts as one transaction");

      expect(getToolExecution(result, "insert-first").isError).toBe(false);
      expect(getToolExecution(result, "insert-second").isError).toBe(false);
      expect(batchId(getToolExecutionDetails(getToolExecution(result, "insert-first")))).toBe(
        batchId(getToolExecutionDetails(getToolExecution(result, "insert-second"))),
      );
      await expect(readFile(file, "utf8")).resolves.toBe(
        ["line-01", "NORMAL-INSERT-1", "line-02", "line-03", "NORMAL-INSERT-2", "line-04"].join(
          "\n",
        ),
      );
    });
  });

  test("applies mixed operations as one change set over a realistic original file", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "transaction.ts");
      const source = [
        "export function loadConfig() {",
        '    const mode = "development";',
        "    const retries = 2;",
        "    const timeout = 1_000;",
        "    const deprecated = true;",
        "    const endpoint = resolveEndpoint(mode);",
        "    const headers = createHeaders();",
        "    validateConfig({ mode, retries, timeout });",
        "    return { mode, retries, timeout, endpoint, headers };",
        "}",
      ].join("\n");
      await writeFile(file, source, "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-mixed-atomic-transaction",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["insert", "replace", "delete", "copy"],
        conversation: [
          assistantMessage(
            [
              call("insert", "mixed-insert", {
                path: "transaction.ts",
                anchor: formatLineHashAnchor(1, "export function loadConfig() {"),
                text: '    const env = process.env.NODE_ENV ?? "development";',
              }),
              call("replace", "mixed-replace", {
                path: "transaction.ts",
                start: formatLineHashAnchor(3, "    const retries = 2;"),
                text: "    const retries = 4;",
              }),
              call("delete", "mixed-delete", {
                path: "transaction.ts",
                start: formatLineHashAnchor(5, "    const deprecated = true;"),
              }),
              call("copy", "mixed-copy", {
                path: "transaction.ts",
                start: formatLineHashAnchor(7, "    const headers = createHeaders();"),
                targetStart: formatLineHashAnchor(
                  9,
                  "    return { mode, retries, timeout, endpoint, headers };",
                ),
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Apply the mixed text transaction");

      for (const callId of ["mixed-insert", "mixed-replace", "mixed-delete", "mixed-copy"]) {
        expect(getToolExecution(result, callId).isError).toBe(false);
      }

      await expect(readFile(file, "utf8")).resolves.toBe(
        [
          "export function loadConfig() {",
          '    const env = process.env.NODE_ENV ?? "development";',
          '    const mode = "development";',
          "    const retries = 4;",
          "    const timeout = 1_000;",
          "    const endpoint = resolveEndpoint(mode);",
          "    const headers = createHeaders();",
          "    validateConfig({ mode, retries, timeout });",
          "    return { mode, retries, timeout, endpoint, headers };",
          "    const headers = createHeaders();",
          "}",
        ].join("\n"),
      );
    });
  });

  test("applies every recoverable call against the original snapshots", async () => {
    await withTempWorkspace(async (directory) => {
      const firstFile = path.join(directory, "atomic-first.txt");
      const secondFile = path.join(directory, "atomic-second.txt");
      await writeFile(firstFile, "alpha\nfirst\nsecond\nomega", "utf8");
      await writeFile(secondFile, "beta\nchange\nomega", "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-stale-recovers-valid-transaction",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              call("replace", "atomic-first", {
                path: "atomic-first.txt",
                start: formatLineHashAnchor(2, "first"),
                text: "first-change",
              }),
              call("replace", "atomic-second", {
                path: "atomic-second.txt",
                start: formatLineHashAnchor(2, "change"),
                text: "second-change",
              }),
              call("replace", "atomic-stale", {
                path: "atomic-first.txt",
                start: formatLineHashAnchor(3, "outdated"),
                text: "must-not-apply",
              }),
              call("replace", "atomic-after-stale", {
                path: "atomic-second.txt",
                start: formatLineHashAnchor(3, "omega"),
                text: "omega-change",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Apply every valid call around the stale anchor");

      expect(getToolExecution(result, "atomic-first").isError).toBe(false);
      expect(getToolExecution(result, "atomic-second").isError).toBe(false);
      expect(getToolExecution(result, "atomic-stale").isError).toBe(true);
      const staleDetails: unknown = getToolExecutionDetails(
        getToolExecution(result, "atomic-stale"),
      );
      expect(staleDetails).toHaveProperty("batchRecovery.state", "failed-not-applied");
      expect(staleDetails).toHaveProperty("batchRecovery.recovered", false);
      expect(getToolExecution(result, "atomic-after-stale").isError).toBe(false);
      const staleResult = getToolResultText(result, "atomic-stale");
      expect(staleResult).toContain(
        `replace blocked: start anchor "${formatLineHashAnchor(3, "outdated")}" is stale`,
      );
      expect(staleResult).toContain("3#352F|second");
      expect(staleResult).not.toContain("Reason:");
      await expect(readFile(firstFile, "utf8")).resolves.toBe("alpha\nfirst-change\nsecond\nomega");
      await expect(readFile(secondFile, "utf8")).resolves.toBe("beta\nsecond-change\nomega-change");
    });
  });

  test("keeps completed streamed calls and aborts the unfinished stale body", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "streamed-batch.txt");
      const source = [
        "alpha",
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "sixth",
        "omega",
      ].join("\n");
      const staleText = Array.from(
        { length: 100 },
        (_, index) => `stale text ${String(index + 1).padStart(2, "0")}`,
      ).join("\n");
      const staleChunks: ChunkSpec = {
        kind: "explicit",
        chunks: [
          `{"start":${JSON.stringify(formatLineHashAnchor(4, "outdated"))},`,
          `"text":${JSON.stringify(staleText)}}`,
        ],
      };
      const tailCalls = [
        { id: "tail-fourth", line: 5, original: "fourth" },
        { id: "tail-fifth", line: 6, original: "fifth" },
        { id: "tail-sixth", line: 7, original: "sixth" },
      ];
      const tailChunks = tailCalls.map(({ id, line, original }, index) => ({
        id,
        contentIndex: index + 4,
        argumentsJson: `{"start":${JSON.stringify(formatLineHashAnchor(line, original))},"text":${JSON.stringify(
          `${id}\n${staleText}`,
        )}}`,
        chunks: {
          kind: "explicit" as const,
          chunks: [
            `{"start":${JSON.stringify(formatLineHashAnchor(line, original))},`,
            `"text":${JSON.stringify(`${id}\n${staleText}`)}}`,
          ],
        },
      }));
      await writeFile(file, source, "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-streamed-stale-batch-tail",
        cwd: directory,
        extensions: [...extensions.paths, staleAnchorExtension],
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              call("replace", "safe-first", {
                path: "streamed-batch.txt",
                start: formatLineHashAnchor(2, "first"),
                text: "first-change",
              }),
              call("replace", "safe-second", {
                start: formatLineHashAnchor(3, "second"),
                text: "second-change",
              }),
              ...tailChunks.map(({ id, contentIndex, argumentsJson, chunks }) =>
                toolCall({
                  id,
                  name: "replace",
                  contentIndex,
                  argumentsJson,
                  chunks,
                  delayMs: 10,
                }),
              ),
              toolCall({
                id: "streamed-stale",
                name: "replace",
                contentIndex: 3,
                argumentsJson: staleChunks.chunks.join(""),
                chunks: staleChunks,
                delayMs: 10,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Apply the batch until an anchor is stale");
      const deltas = result.traceEvents.flatMap((trace) => {
        if (
          trace.type !== "message_update" ||
          typeof trace.event !== "object" ||
          trace.event === null
        ) {
          return [];
        }

        const update = (
          trace.event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } }
        ).assistantMessageEvent;
        return update?.type === "toolcall_delta" && typeof update.delta === "string"
          ? [update.delta]
          : [];
      });

      expect(getToolCallNames(result).filter((name) => name === "replace")).toHaveLength(6);
      expect(
        getToolExecutions(result)
          .filter(({ toolName }) => toolName === "replace")
          .map(({ toolCallId }) => toolCallId)
          .sort(),
      ).toEqual(
        ["safe-first", "safe-second", "streamed-stale", ...tailCalls.map(({ id }) => id)].sort(),
      );
      expect(getToolExecution(result, "streamed-stale").isError).toBe(true);
      expect(getToolExecution(result, "safe-first").isError).toBe(false);
      expect(getToolExecution(result, "safe-second").isError).toBe(false);
      for (const { id } of tailCalls) {
        expect(getToolExecution(result, id).isError).toBe(false);
      }
      expect(getToolResultText(result, "streamed-stale")).toContain("start anchor");
      expect(deltas).toContain(staleChunks.chunks[0]);
      expect(deltas).not.toContain(staleChunks.chunks[1]);

      for (const tail of tailChunks) {
        expect(deltas).toContain(tail.chunks.chunks[0]);
        expect(deltas).toContain(tail.chunks.chunks[1]);
      }

      await expect(readFile(file, "utf8")).resolves.toBe(
        [
          "alpha",
          "first-change",
          "second-change",
          "third",
          ...tailCalls.flatMap(({ id }) => [id, ...staleText.split("\n")]),
          "omega",
        ].join("\n"),
      );
    });
  });
});
