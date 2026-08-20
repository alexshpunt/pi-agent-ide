import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
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
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { runTextToolScenario } from "#integration/support/pi-runtime/scenario.js";

const base = createExtensionSet();
const registration = path.join(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/register-extension.ts",
);
const staleAnchorExtension = path.join(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.ts",
);
const extensions = base.paths
  .filter((candidate) => !candidate.endsWith("pi-agent-text-editor/register-extension.ts"))
  .concat(registration, staleAnchorExtension);
afterAll(() => base.dispose());

const largeOverwriteContent = Array.from(
  { length: 12 },
  (_, index) => `overwrite streamed line ${String(index + 1).padStart(2, "0")}`,
).join("\n");
const completeOverwriteArgumentsJson = JSON.stringify({
  path: "write.txt",
  content: largeOverwriteContent,
});
const overwriteDeliveries: readonly {
  readonly name: string;
  readonly chunks: ChunkSpec;
  readonly expectedDeltaCount: number;
}[] = [
  {
    name: "while arguments are still streaming",
    chunks: {
      kind: "explicit",
      chunks: ['{"path":"write.txt",', `"content":${JSON.stringify(largeOverwriteContent)}}`],
    },
    expectedDeltaCount: 1,
  },
  {
    name: "when all arguments arrive together",
    chunks: { kind: "explicit", chunks: [completeOverwriteArgumentsJson] },
    expectedDeltaCount: 1,
  },
];

async function runBlockedWrite(directory: string, callId: string, chunks: ChunkSpec) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: callId,
    cwd: directory,
    extensions,
    tools: ["write"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: callId,
            name: "write",
            argumentsJson: completeOverwriteArgumentsJson,
            chunks,
            delayMs: 0,
          }),
          toolCall({
            id: `${callId}-sentinel`,
            name: "write",
            arguments: { path: "sentinel.txt", content: "must-not-run\n" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          toolCall({
            id: `${callId}-recovery`,
            name: "write",
            arguments: { path: "write.txt", content: largeOverwriteContent },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("done")]),
    ],
  }).run("Overwrite an existing file");
}

function toolCallDeltaCount(
  result: Awaited<ReturnType<typeof runBlockedWrite>>,
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

describe("pi-agent-text-editor overwrite guard", () => {
  test.each(overwriteDeliveries)(
    "blocks a write $name",
    async ({ name, chunks, expectedDeltaCount }) => {
      await withTempWorkspace(async (directory) => {
        const file = await createFixture(directory, "write.txt", "before\n");
        const callId = name.includes("streaming")
          ? "overwrite-write-streamed"
          : "overwrite-write-complete";
        const result = await runBlockedWrite(directory, callId, chunks);

        expect(getToolExecution(result, callId).isError).toBe(true);
        expect(getToolResultText(result, callId)).not.toContain("MUTATION_REJECTED");
        expect(getToolResultText(result, callId)).toContain("Reason: The file already exists");
        expect(getToolCallNames(result).filter((tool) => tool === "write")).toEqual([
          "write",
          "write",
        ]);
        expect(getToolExecution(result, `${callId}-recovery`).isError).toBe(false);
        expect(toolCallDeltaCount(result, chunks)).toBe(expectedDeltaCount);
        await expect(readFile(file, "utf8")).resolves.toBe(largeOverwriteContent);
        await expect(readFile(path.join(directory, "sentinel.txt"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  test("blocks replace when resolved anchors cover the complete file", async () => {
    await withTempWorkspace(async (directory) => {
      const original = "first\nmiddle\nlast\n";
      const file = await createFixture(directory, "replace.txt", original);
      const scenario = await runTextToolScenario({
        extensions,
        cwd: directory,
        testName: "overwrite-replace",
        tool: "replace",
        arguments: {
          path: "replace.txt",
          start: formatLineHashAnchor(1, "first"),
          end: formatLineHashAnchor(3, "last"),
          text: "replacement",
        },
      });

      expect(getToolResultText(scenario.result, scenario.mutationCallId)).not.toContain(
        "MUTATION_REJECTED",
      );
      expect(getToolResultText(scenario.result, scenario.mutationCallId)).toContain(
        "Reason: The file already exists",
      );
      await expect(readFile(file, "utf8")).resolves.toBe(original);
    });
  });

  test("blocks streamed replace before replacement text is generated and keeps recovery", async () => {
    await withTempWorkspace(async (directory) => {
      const original = "first\nmiddle\nlast\n";
      const file = await createFixture(directory, "replace-streamed.txt", original);
      const start = formatLineHashAnchor(1, "first");
      const end = formatLineHashAnchor(3, "last");
      const replacement = Array.from(
        { length: 12 },
        (_, index) => `replacement streamed line ${String(index + 1).padStart(2, "0")}`,
      ).join("\n");
      const argumentsJson = JSON.stringify({
        path: "replace-streamed.txt",
        start,
        end,
        text: replacement,
      });
      const boundaryArguments = JSON.stringify({ path: "replace-streamed.txt", start, end });
      const chunks: ChunkSpec = {
        kind: "explicit",
        chunks: [`${boundaryArguments.slice(0, -1)},`, `"text":${JSON.stringify(replacement)}}`],
      };
      const callId = "overwrite-replace-streamed";
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: callId,
        cwd: directory,
        extensions,
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({ id: callId, name: "replace", argumentsJson, chunks, delayMs: 0 }),
              toolCall({
                id: `${callId}-sentinel`,
                name: "replace",
                arguments: { path: "replace-streamed.txt", start, end, text: "must-not-run" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: `${callId}-recovery`,
                name: "replace",
                arguments: { path: "replace-streamed.txt", start, end, text: replacement },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Replace a complete file, then recover");

      expect(getToolExecution(result, callId).isError).toBe(true);
      expect(getToolResultText(result, callId)).toContain("Reason: The file already exists");
      expect(getToolCallNames(result).filter((tool) => tool === "replace")).toEqual([
        "replace",
        "replace",
      ]);
      expect(getToolExecution(result, `${callId}-recovery`).isError).toBe(false);
      expect(toolCallDeltaCount(result, chunks)).toBe(1);
      await expect(readFile(file, "utf8")).resolves.toBe(`${replacement}\n`);
    });
  });

  test.each(["copy", "move"] as const)(
    "blocks %s when its target range covers the complete file",
    async (tool) => {
      await withTempWorkspace(async (directory) => {
        const source = await createFixture(directory, "source.txt", "copy-me\nkeep\n");
        const target = await createFixture(directory, "target.txt", "target-first\ntarget-last\n");
        const scenario = await runTextToolScenario({
          extensions,
          cwd: directory,
          testName: `overwrite-${tool}`,
          tool,
          arguments: {
            path: "source.txt",
            start: formatLineHashAnchor(1, "copy-me"),
            target: "target.txt",
            targetStart: formatLineHashAnchor(1, "target-first"),
            targetEnd: formatLineHashAnchor(2, "target-last"),
          },
        });

        expect(getToolResultText(scenario.result, scenario.mutationCallId)).not.toContain(
          "MUTATION_REJECTED",
        );
        expect(getToolResultText(scenario.result, scenario.mutationCallId)).toContain(
          "Reason: The file already exists",
        );
        await expect(readFile(source, "utf8")).resolves.toBe("copy-me\nkeep\n");
        await expect(readFile(target, "utf8")).resolves.toBe("target-first\ntarget-last\n");
      });
    },
  );
});
