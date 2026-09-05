import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  type ChunkSpec,
  getToolCallNames,
  getToolExecution,
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
const overwriteExtension = path.join(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/index.ts",
);
const argumentOrderExtension = path.join(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-argument-order/index.ts",
);
const rebindProviderExtension = path.join(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/rebind-provider-extension.ts",
);
const annotationRecorderExtension = path.join(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/annotation-recorder-extension.ts",
);

afterAll(() => extensions.dispose());

async function runInsert(directory: string, callId: string, anchor: string) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: callId,
    cwd: directory,
    extensions: [...extensions.paths, staleAnchorExtension, overwriteExtension],
    tools: ["insert"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: callId,
            name: "insert",
            arguments: { path: "subject.txt", anchor, text: "inserted" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("done")]),
    ],
  }).run("Insert text");
}

const staleArgumentsJson = '{"path":"subject.txt","anchor":"1#AAAA","text":"inserted"}';
const largeStaleText = Array.from(
  { length: 12 },
  (_, index) => `stale streamed line ${String(index + 1).padStart(2, "0")}`,
).join("\n");
const largeStaleArgumentsJson = `{"anchor":"1#AAAA","path":"subject.txt","text":${JSON.stringify(largeStaleText)}}`;
const largeStaleChunks: ChunkSpec = {
  kind: "explicit",
  chunks: [
    '{"',
    'anchor":"1#AAAA","path":"subject.txt",',
    `"text":${JSON.stringify(largeStaleText)}}`,
  ],
};
const staleDeliveries: readonly { readonly name: string; readonly chunks: ChunkSpec }[] = [
  {
    name: "while arguments are still streaming",
    chunks: {
      kind: "explicit",
      chunks: ['{"path":"subject.txt","anchor":"1#AAAA",', '"text":"inserted"}'],
    },
  },
  {
    name: "when all arguments arrive together",
    chunks: { kind: "explicit", chunks: [staleArgumentsJson] },
  },
];

async function runBlockedInsert(directory: string, callId: string, chunks: ChunkSpec) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: callId,
    cwd: directory,
    extensions: [...extensions.paths, staleAnchorExtension],
    tools: ["insert"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: callId,
            name: "insert",
            argumentsJson: staleArgumentsJson,
            chunks,
          }),
          toolCall({
            id: `${callId}-sentinel`,
            name: "insert",
            arguments: { path: "subject.txt", anchor: "1#BE76", text: "must-not-run" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          text("retry"),
          toolCall({
            id: `${callId}-recovery`,
            name: "insert",
            arguments: { path: "subject.txt", anchor: "1#BE76", text: "recovered" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("done")]),
    ],
  }).run("Insert text with a stale anchor");
}

function toolCallDeltaCount(
  result: Awaited<ReturnType<typeof runBlockedInsert>>,
  chunks: ChunkSpec,
): number {
  if (chunks.kind !== "explicit") {
    throw new Error("This scenario requires explicit chunks");
  }

  const expected = new Set(chunks.chunks);
  return result.traceEvents.filter((trace) => {
    if (
      trace.type !== "message_update" ||
      typeof trace.event !== "object" ||
      trace.event === null
    ) {
      return false;
    }

    const update = (trace.event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } })
      .assistantMessageEvent;
    return (
      update?.type === "toolcall_delta" &&
      typeof update.delta === "string" &&
      expected.has(update.delta)
    );
  }).length;
}

describe("pi-agent-text-editor stale anchor", () => {
  test("allows a fresh dynamic line-hash anchor", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "subject.txt");
      await writeFile(file, "alpha\nbeta", "utf8");
      const result = await runInsert(directory, "fresh-anchor", "1#BE76");

      expect(getToolExecution(result, "fresh-anchor").isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\ninserted\nbeta");
    });
  });

  test.each(staleDeliveries)("blocks a stale anchor $name", async ({ name, chunks }) => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "subject.txt");
      await writeFile(file, "alpha\nbeta", "utf8");
      const callId = name.includes("streaming") ? "stale-anchor-streamed" : "stale-anchor-complete";
      const result = await runBlockedInsert(directory, callId, chunks);

      expect(getToolExecution(result, callId).isError).toBe(true);
      expect(getToolResultText(result, callId)).toContain(
        'insert blocked: anchor anchor "1#AAAA" is stale',
      );
      expect(getToolResultText(result, callId)).toContain("1#BE76");
      expect(getToolCallNames(result).filter((tool) => tool === "insert")).toEqual([
        "insert",
        "insert",
      ]);
      expect(getToolExecution(result, `${callId}-recovery`).isError).toBe(false);
      expect(toolCallDeltaCount(result, chunks)).toBe(1);
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\nrecovered\nbeta");
    });
  });

  test("blocks two consecutive streamed stale anchors", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "subject.txt");
      const firstCallId = "stale-before-recovery";
      const readCallId = "read-between-stale-calls";
      const recoveryCallId = "recovery-with-reused-content-index";
      const largeCallId = "large-stale-with-reused-content-index";
      await writeFile(file, "alpha\nbeta", "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: largeCallId,
        cwd: directory,
        extensions: [
          ...extensions.paths,
          staleAnchorExtension,
          overwriteExtension,
          argumentOrderExtension,
          rebindProviderExtension,
        ],
        tools: ["insert", "read"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: firstCallId,
                name: "insert",
                argumentsJson: staleArgumentsJson,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: readCallId,
                name: "read",
                arguments: { path: "subject.txt" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: largeCallId,
                name: "insert",
                argumentsJson: largeStaleArgumentsJson,
                chunks: largeStaleChunks,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: recoveryCallId,
                name: "insert",
                arguments: { path: "subject.txt", anchor: "1#BE76", text: "recovered" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Reuse a content index after stale interception");
      const firstBlockedResult = getToolResultText(result, firstCallId);
      const largeBlockedResult = getToolResultText(result, largeCallId);

      const reboundCalls = (await readFile(path.join(directory, "rebound-provider.log"), "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(reboundCalls).toHaveLength(1);
      expect(firstBlockedResult).toContain('insert blocked: anchor anchor "1#AAAA" is stale');
      expect(firstBlockedResult).toContain("1#BE76");
      expect(firstBlockedResult).not.toContain("Validation failed");
      expect(firstBlockedResult).not.toContain("Received arguments");
      expect(getToolExecution(result, readCallId).isError).toBe(false);
      expect(result.providerRequests.length).toBeGreaterThanOrEqual(5);
      expect(getToolExecution(result, recoveryCallId).isError).toBe(false);
      expect(largeBlockedResult).toContain('insert blocked: anchor anchor "1#AAAA" is stale');
      expect(largeBlockedResult).toContain("1#BE76");
      expect(largeBlockedResult).not.toContain("Validation failed");
      expect(largeBlockedResult).not.toContain("Received arguments");
      expect(toolCallDeltaCount(result, largeStaleChunks)).toBe(2);
      expect(getToolCallNames(result).filter((tool) => tool === "insert")).toEqual([
        "insert",
        "insert",
        "insert",
      ]);
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\nrecovered\nbeta");
    });
  });

  // Regression: a call blocked mid-stream must not leak its annotation onto the
  // next streamed call that reuses the same content index.
  test("does not leak the blocked annotation onto the next streamed call", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "subject.txt");
      const blockedCallId = "leak-blocked";
      const nextCallId = "leak-next";
      await writeFile(file, "alpha\nbeta", "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: nextCallId,
        cwd: directory,
        extensions: [...extensions.paths, staleAnchorExtension, annotationRecorderExtension],
        tools: ["insert"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: blockedCallId,
                name: "insert",
                argumentsJson: staleArgumentsJson,
                chunks: staleDeliveries[0].chunks,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: nextCallId,
                name: "insert",
                argumentsJson: '{"path":"subject.txt","anchor":"1#BE76","text":"patched"}',
                chunks: {
                  kind: "explicit",
                  chunks: ['{"path":"subject.txt","anchor":"1#BE76",', '"text":"patched"}'],
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Insert after a mid-stream blocked insert");

      expect(getToolResultText(result, blockedCallId)).toContain(
        'insert blocked: anchor anchor "1#AAAA" is stale',
      );
      expect(getToolExecution(result, nextCallId).isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\npatched\nbeta");

      // Only the actually blocked call may be annotated; a leaked annotation
      // would arrive here tagged with the second call's id.
      const annotations = (await readFile(path.join(directory, "annotation-events.log"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { toolCallId: string; annotation: { kind: string } });
      expect(annotations).toEqual([
        { toolCallId: blockedCallId, annotation: { kind: "stale-anchor" } },
      ]);
    });
  });
});
