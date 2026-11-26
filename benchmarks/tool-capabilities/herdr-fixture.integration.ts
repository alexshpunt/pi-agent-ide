import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

const once = { chunks: { kind: "fixed" as const, size: Number.MAX_SAFE_INTEGER } };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args, ...once })], { stopReason: "toolUse" });

test("capability bridge supports agent resource and launch routes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "lpt-1878-herdr-matrix-"));
  try {
    const root = process.cwd();
    const result = await new PiIntegrationTest({
      testName: "herdr-capability-fixture",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [
        path.join(root, "src/pi-agent-ide.ts"),
        path.join(root, "integrations/herdr/src/index.ts"),
        path.join(root, "benchmarks/tool-capabilities/herdr-fixture.ts"),
      ],
      tools: ["read", "write", "delete", "replicate", "subagent", "wait_for_agents"],
      timeoutMs: 90000,
      conversation: [
        call("list", "read", { path: "herdr:" }),
        call("read", "read", { path: "herdr:fixture/t7" }),
        call("wait", "wait_for_agents", { path: "herdr:fixture/t7" }),
        call("send", "write", { path: "herdr:fixture/t7", content: "hello-fixture" }),
        call("profiles", "read", { path: "herdr:profiles" }),
        call("sub", "subagent", {
          name: "check-fixture",
          task: "Inspect the fixture",
          profile: "research",
        }),
        call("close-sub", "delete", { path: "herdr:fixture/t9" }),
        call("rep", "replicate", { name: "check-fixture", task: "Inspect the fixture" }),
        call("send-rep", "write", { path: "herdr:fixture/t9", content: "hello-fixture" }),
        call("close-rep", "delete", { path: "herdr:fixture/t9" }),
        assistantMessage([text("Done", once)]),
      ],
    }).run("Exercise the Herdr capability fixture.");
    for (const id of [
      "list",
      "read",
      "send",
      "profiles",
      "sub",
      "close-sub",
      "rep",
      "send-rep",
      "close-rep",
      "wait",
    ])
      expect(getToolExecution(result, id).isError, id).toBe(false);
    expect(await readFile(path.join(cwd, "herdr-journal.txt"), "utf8")).toBe(
      "send:fixture/t7:hello-fixture\nsubagent:check-fixture:research\nremove:fixture/t9\nreplicate:check-fixture\nsend:fixture/t9:hello-fixture\nremove:fixture/t9\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
