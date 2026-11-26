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

// Contract: an agent reads the current workflow profiles, hands a side track to a fresh sub-agent with one of them,
// every new stop of the sub-agent wakes the agent with its timeline, the agent steers it without reading it first,
// a profile the user adds shows on the next read, and delete closes the sub-agent for good.
test("subagent starts a followed fresh agent with a workflow profile that the caller steers and closes", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "herdr-subagent-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "herdr-subagent",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [ide.extension, path.join(root, "tests/fixtures/subagent-bridge.ts")],
      tools: ["read", "write", "delete", "subagent", "herdr_subagent_fixture"],
      timeoutMs: 90000,
      conversation: [
        calls(["profiles", "read", { path: "herdr:profiles" }]),
        calls([
          "sub",
          "subagent",
          { name: "research-tooltips", task: "Find how GPUI shows tooltips.", profile: "research" },
        ]),
        calls(["finish", "herdr_subagent_fixture", { status: "done", reply: "tooltips-found" }]),
        assistantMessage([text("Back to my own task.", once)]),
        calls(["steer", "write", { path: "herdr:laptop/t7", content: "Also check popovers." }]),
        assistantMessage([text("Steered the sub-agent.", once)]),
        calls(["add", "herdr_subagent_fixture", { profile: "review" }]),
        calls(["profiles2", "read", { path: "herdr:profiles" }]),
        calls(["close", "delete", { path: "herdr:laptop/t7" }]),
        calls(["state", "herdr_subagent_fixture", {}]),
        assistantMessage([text("Sub-agent closed.", once)]),
      ],
    }).run("Research GPUI tooltips on the side.");
    await ide.record(result.artifacts.directory);

    for (const value of ["research", "Research", "fixture/fast", "low", "Research and searches"])
      expect(getToolResultText(result, "profiles")).toContain(value);
    expect(getToolExecution(result, "sub").isError).toBe(false);
    expect(getToolResultText(result, "sub")).toContain("herdr:laptop/t7");
    expect(getToolExecutionDetails(getToolExecution(result, "sub"))).toMatchObject({
      terminal: "laptop/t7",
      kind: "subagent",
      profile: "research",
      folder: cwd,
    });
    for (const value of ["review", "fixture/new", "medium"])
      expect(getToolResultText(result, "profiles2")).toContain(value);

    const state = getToolExecutionDetails(getToolExecution(result, "state")) as {
      agent: unknown;
      sent: string[];
      commands: string[];
      launch: { requestId: string; name: string; folder: string; profile: string; task: string };
    };
    expect(state.launch).toMatchObject({
      name: "research-tooltips",
      folder: cwd,
      profile: "research",
    });
    expect(state.launch.requestId).toMatch(/^subagent-.+-sub$/u);
    expect(state.launch.task).toContain("research-tooltips");
    expect(state.launch.task).toContain("Find how GPUI shows tooltips.");
    expect(state.sent).toEqual(["Also check popovers."]);
    expect(state.agent).toBeNull();
    expect(getToolExecution(result, "steer").isError).toBe(false);
    expect(getToolExecution(result, "close").isError).toBe(false);

    const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot");
    const branch = snapshot?.branch as { type: string; customType?: string; content?: unknown }[];
    const messages = branch
      .filter((entry) => entry.type === "custom_message" && entry.customType === "herdr-replica")
      .map((entry) => String(entry.content));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("herdr:laptop/t7");
    expect(messages[0]).toContain("tooltips-found");
    expect(messages[1]).toContain("answer-to: Also check popovers.");
    expect(
      branch.some(
        (entry) => entry.type === "custom" && entry.customType === "herdr-replica-closed",
      ),
    ).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
