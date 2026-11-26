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

// Contract: wait_for_agents is found through tool_search, returns in the foreground, delivers background results
// to an idle agent, and moves a foreground wait to the background when a new message arrives.
test("wait_for_agents waits in the foreground, in the background and after a new message", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "herdr-wait-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "herdr-wait",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [
        ide.extension,
        "builtin:tool-search",
        path.join(root, "tests/fixtures/wait-bridge.ts"),
      ],
      tools: ["read", "tool_search", "herdr_wait_fixture"],
      timeoutMs: 90000,
      conversation: [
        calls(["search", "tool_search", { query: "wait_for_agents" }]),
        calls(
          ["foreground", "wait_for_agents", { path: "herdr:t9" }],
          ["unknown", "wait_for_agents", { path: ["herdr:t9", "herdr:t99"] }],
        ),
        calls([
          "background",
          "wait_for_agents",
          { path: ["herdr:t7", "herdr:t8"], background: true },
        ]),
        calls(["finish-t7", "herdr_wait_fixture", { terminal: "t7", status: "done" }]),
        assistantMessage([text("Other work finished.", once)]),
        calls(
          ["released", "wait_for_agents", { path: "herdr:t10" }],
          ["steer", "herdr_wait_fixture", { steer: "steer-message-fixture" }],
        ),
        calls(["finish-t10", "herdr_wait_fixture", { terminal: "t10", status: "done" }]),
        assistantMessage([text("Released wait checked.", once)]),
        assistantMessage([text("Fixture complete.", once)]),
      ],
    }).run("Coordinate the fixture agents and wait for them.");
    await ide.record(result.artifacts.directory);

    expect(getToolExecutionDetails(getToolExecution(result, "search"))).toMatchObject({
      loaded: ["wait_for_agents"],
    });
    expect(getToolExecution(result, "foreground").isError).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(result, "foreground"))).toMatchObject({
      agents: ["herdr:t9"],
      status: "stopped",
    });
    expect(getToolResultText(result, "foreground")).toContain("reply-of-t9 (done)");
    expect(getToolExecution(result, "unknown").isError).toBe(true);
    expect(getToolResultText(result, "unknown")).toContain("HERDR_UNKNOWN_AGENT");
    expect(getToolExecutionDetails(getToolExecution(result, "background"))).toMatchObject({
      status: "waiting",
      agents: ["herdr:t7", "herdr:t8"],
    });
    expect(getToolExecutionDetails(getToolExecution(result, "released"))).toMatchObject({
      agents: ["herdr:t10"],
      status: "waiting",
    });

    const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot");
    const branch = snapshot?.branch as { type: string; customType?: string; content?: unknown }[];
    const messages = branch
      .filter(
        (entry) => entry.type === "custom_message" && entry.customType === "herdr-agents-wait",
      )
      .map((entry) => String(entry.content));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("herdr:t7");
    expect(messages[0]).toContain("reply-of-t7 (done)");
    expect(messages[0]).toContain("herdr:t8");
    expect(messages[1]).toContain("herdr:t10");
    expect(messages[1]).toContain("reply-of-t10 (done)");

    const requests = result.providerRequests.map((request) => JSON.stringify(request));
    expect(requests).toHaveLength(9);
    // The steering message reached the model right after the released wait, before the agents finished.
    expect(requests[6]).toContain("steer-message-fixture");
    expect(requests[6]).not.toContain("reply-of-t10 (done)");
    expect(requests[8]).toContain("reply-of-t10 (done)");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
