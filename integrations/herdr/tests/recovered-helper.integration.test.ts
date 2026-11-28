import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

const root = path.dirname(import.meta.dirname);
const once = { chunks: { kind: "fixed" as const, size: Number.MAX_SAFE_INTEGER } };

test("a recovered helper launch is followed after its outcome is persisted", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "recovered-helper-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "recovered-helper",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [ide.extension, path.join(root, "tests/fixtures/recovered-helper-bridge.ts")],
      tools: ["fixture_wait"],
      timeoutMs: 90000,
      conversation: [
        assistantMessage([toolCall({ id: "wait", name: "fixture_wait", arguments: {}, ...once })], {
          stopReason: "toolUse",
        }),
        assistantMessage(
          [toolCall({ id: "wait-again", name: "fixture_wait", arguments: {}, ...once })],
          {
            stopReason: "toolUse",
          },
        ),
        assistantMessage(
          [toolCall({ id: "watch", name: "fixture_wait", arguments: {}, ...once })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Fixture complete.", once)]),
      ],
    }).run("Resume the helper.");
    await ide.record(result.artifacts.directory);
    const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot");
    const branch = snapshot?.branch as { type: string; customType?: string; content?: unknown }[];
    expect(
      branch.some(
        (entry) => entry.type === "custom_message" && entry.customType === "herdr-recovery",
      ),
    ).toBe(true);
    expect(
      branch.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "herdr-replica" &&
          String(entry.content).includes("recovered-helper-result"),
      ),
    ).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
