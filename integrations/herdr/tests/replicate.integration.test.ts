import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

const root = path.dirname(import.meta.dirname);
const once = { chunks: { kind: "fixed" as const, size: Number.MAX_SAFE_INTEGER } };
const calls = (...items: [string, string, Record<string, unknown>][]) =>
  assistantMessage(
    items.map(([id, name, args]) => toolCall({ id, name, arguments: args, ...once })),
    { stopReason: "toolUse" },
  );

// Contract: replicate copies the session into a new Herdr agent, every new stop of the replica wakes the original
// with its timeline, the original steers the replica without reading it first, and delete closes it for good.
test("replicate starts a followed replica that the original steers and closes", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "herdr-replicate-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "herdr-replicate",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [ide.extension, path.join(root, "tests/fixtures/replicate-bridge.ts")],
      tools: ["read", "write", "delete", "replicate", "herdr_replica_fixture"],
      timeoutMs: 90000,
      conversation: [
        calls(["deep", "replicate", { name: "too-deep", task: "Nested too deep." }]),
        calls(["rep", "replicate", { name: "check-auth", task: "Check the auth module." }]),
        calls(["work", "herdr_replica_fixture", { status: "working" }]),
        calls(["finish", "herdr_replica_fixture", { status: "done", reply: "first-result" }]),
        assistantMessage([text("Working on my own block.", once)]),
        calls(["steer", "write", { path: "herdr:laptop/t9", content: "Also check logout." }]),
        assistantMessage([text("Steered the replica.", once)]),
        calls(["close", "delete", { path: "herdr:laptop/t9" }]),
        calls(["state", "herdr_replica_fixture", {}]),
        assistantMessage([text("Replica closed.", once)]),
      ],
    }).run("Coordinate a replica for the auth check.");
    await ide.record(result.artifacts.directory);

    // Past the nesting depth nothing starts, and the prepared session copy is gone.
    expect(getToolExecution(result, "deep").isError).toBe(true);
    expect(getToolResultText(result, "deep")).toContain("HERDR_NESTING_LIMIT");
    expect(getToolExecution(result, "rep").isError).toBe(false);
    expect(getToolResultText(result, "rep")).toContain("herdr:laptop/t9");
    expect(getToolExecutionDetails(getToolExecution(result, "rep"))).toMatchObject({
      terminal: "laptop/t9",
      name: "check-auth",
      space: "laptop/sp1",
    });

    const state = getToolExecutionDetails(getToolExecution(result, "state")) as {
      replica: unknown;
      refusedSession: string;
      sent: string[];
      commands: string[];
      launch: {
        name: string;
        folder: string;
        model: string;
        thinking: string;
        task: string;
        header: { parentSession: string };
        answers: string[];
        copiedUser: boolean;
      };
    };
    expect(state.launch).toMatchObject({ name: "check-auth", folder: cwd, copiedUser: true });
    expect(state.launch.model).toMatch(/^[^/]+\/.+/u);
    expect(state.launch.task).toContain("check-auth");
    expect(state.launch.task).toContain("Check the auth module.");
    expect(state.launch.header.parentSession).toMatch(/\.jsonl$/u);
    // The copy holds the refused call's result too; the open replicate call gets the replica's own answer.
    expect(state.launch.answers).toEqual([
      expect.stringContaining("HERDR_NESTING_LIMIT"),
      expect.stringContaining("check-auth"),
    ]);
    expect(state.refusedSession).toMatch(/\.jsonl$/u);
    expect(existsSync(state.refusedSession)).toBe(false);
    expect(state.sent).toEqual(["Also check logout."]);
    expect(state.replica).toBeNull();
    expect(state.commands).toContain("agent.remove");
    expect(getToolExecution(result, "steer").isError).toBe(false);
    expect(getToolExecution(result, "close").isError).toBe(false);

    const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot");
    const branch = snapshot?.branch as { type: string; customType?: string; content?: unknown }[];
    const messages = branch
      .filter((entry) => entry.type === "custom_message" && entry.customType === "herdr-replica")
      .map((entry) => String(entry.content));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("herdr:laptop/t9");
    expect(messages[0]).toContain("first-result");
    expect(messages[1]).toContain("answer-to: Also check logout.");
    expect(
      branch.some(
        (entry) => entry.type === "custom" && entry.customType === "herdr-replica-closed",
      ),
    ).toBe(true);

    const requests = result.providerRequests.map((request) => JSON.stringify(request));
    expect(requests).toHaveLength(10);
    // Each replica stop started a turn of the idle original.
    expect(requests[5]).toContain("first-result");
    expect(requests[7]).toContain("answer-to: Also check logout.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
