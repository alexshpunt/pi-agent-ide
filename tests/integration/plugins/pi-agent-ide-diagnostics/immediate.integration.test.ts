import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  PiIntegrationTest,
  PiRun,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { afterAll } from "vitest";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("a late finding wakes idle Pi without user input and renders once", async () => {
  const root = path.resolve(".agents/tmp/immediate-diagnostics");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "project-"));
  try {
    await writeFile(path.join(cwd, "example.ts"), "export const value = 1;\n");
    const result = await new PiIntegrationTest({
      testName: "idle-diagnostic-wakeup",
      artifactsDir: path.join(root, "runs"),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: ["src/core/extension.ts", "tests/integration/fixtures/idle-diagnostics.ts"].map(
        (file) => path.resolve(file),
      ),
      tools: ["arm_diagnostics", "ack_diagnostics"],
      conversation: [
        assistantMessage([toolCall({ id: "arm", name: "arm_diagnostics", arguments: {} })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("First run finished.")]),
        assistantMessage([toolCall({ id: "ack", name: "ack_diagnostics", arguments: {} })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Late finding received.")]),
      ],
    }).run("Arm the check and finish; acknowledge a later diagnostic if awakened.");
    expect(JSON.parse(await readFile(path.join(cwd, "idle-observed.json"), "utf8"))).toEqual({
      idle: true,
    });
    expect(await readFile(path.join(cwd, "acknowledged.txt"), "utf8")).toBe("acknowledged");
    const captured = await PiRun.open(result.artifacts.run);
    const entries = (captured.session ?? "")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            customType?: string;
            display?: boolean;
            data?: { sources: unknown };
          },
      );
    const messages = entries.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "ide-diagnostics",
    );
    const summaries = entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "ide-diagnostic-summary",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ display: false });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.data?.sources).toEqual([
      {
        source: "late-checker",
        status: "ready",
        counts: { error: 1, warning: 0, info: 0, hint: 0 },
      },
    ]);
    expect(result.tuiRenderedOutput).toContain("(late-checker)");
    expect(result.state.isIdle).toBe(true);
    expect(result.traceEvents.filter((event) => event.type === "agent_start")).toHaveLength(2);
    const modelMessages = result.providerRequests.at(-1)?.messages as { role: string }[];
    expect(modelMessages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(result.state.hasPendingMessages).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
