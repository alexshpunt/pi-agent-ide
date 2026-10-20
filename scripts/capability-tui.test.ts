import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertTuiInvocation, mirrorTuiEvents } from "#capabilities/tui.ts";
import { parseEvents, validateRoute } from "#capabilities/validation.ts";
import { expect, test } from "vitest";

const selection = {
  run: true,
  models: ["fixture"],
  cases: ["fixture"],
  mode: "direct",
  attempts: 1,
  stdinIsTTY: true,
  stdoutIsTTY: true,
};

test("a TUI invocation selects exactly one explicit paid route in a real terminal", () => {
  expect(() => assertTuiInvocation(selection)).not.toThrow();
});

test.each([
  { run: false },
  { models: undefined },
  { models: ["a", "b"] },
  { cases: undefined },
  { cases: ["a", "b"] },
  { mode: undefined },
  { attempts: 2 },
  { stdinIsTTY: false },
  { stdoutIsTTY: false },
])("a broader or headless TUI invocation is rejected: %j", (change) => {
  expect(() => assertTuiInvocation({ ...selection, ...change })).toThrow(/--tui/);
});

test("public TUI observations preserve raw aliases, nested execution and failed results", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/capability-tui-"));
  try {
    const handlers = new Map<string, (event: unknown) => void>();
    const pi: Pick<ExtensionAPI, "on"> = {
      on: (name, handler) => {
        handlers.set(name, handler as (event: unknown) => void);
        return () => {
          handlers.delete(name);
        };
      },
    };
    const file = path.join(root, "events.jsonl");
    mirrorTuiEvents(pi as ExtensionAPI, file);
    const events = [
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "p", toolName: "codemode", args: {} },
      {
        type: "tool_execution_start",
        toolCallId: "p/0",
        parentToolCallId: "p",
        toolName: "mcp__fixture__read",
        args: { path: "fixture" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "p/0",
        parentToolCallId: "p",
        toolName: "mcp__fixture__read",
        isError: true,
        result: { content: [{ type: "text", text: "Refused" }] },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "fixture",
          model: "fixture",
          content: [{ type: "text", text: "Done" }],
        },
      },
      { type: "agent_settled" },
    ];
    for (const event of events) handlers.get(event.type)?.(event);
    const captured = parseEvents(await readFile(file, "utf8"));
    expect(captured.slice(1)).toEqual(events);
    expect(validateRoute({ steps: [{ tool: "read" }] }, captured, "codemode").passed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sandbox = pathToFileURL(path.resolve("benchmarks/tool-capabilities/sandbox.ts")).href;

test.skipIf(!existsSync("/usr/bin/script"))(
  "terminal children inherit native TTY descriptors without captured escape output",
  () => {
    const code = `import { runProcess } from ${JSON.stringify(sandbox)};
    const result = await runProcess(process.execPath, ["-e", 'console.log("TTY "+JSON.stringify([process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY]))'], {terminal:true,timeoutMs:3000});
    console.log("RESULT",JSON.stringify(result));`;
    const output = execFileSync(
      "/usr/bin/script",
      [
        "-q",
        "-e",
        "-c",
        `${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(code)}`,
        "/dev/null",
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    expect(output).toContain("TTY [true,true,true]");
    expect(output).toContain('"code":0');
    expect(output).toContain('"stdout":"","stderr":""');
  },
);

test.skipIf(!existsSync("/usr/bin/script"))(
  "terminal children retain the bounded timeout and actual termination status",
  () => {
    const code = `import { runProcess } from ${JSON.stringify(sandbox)};
    const result = await runProcess(process.execPath, ["-e", 'setInterval(()=>{},1000)'], {terminal:true,timeoutMs:300});
    console.log("RESULT",JSON.stringify(result));`;
    const output = execFileSync(
      "/usr/bin/script",
      [
        "-q",
        "-e",
        "-c",
        `${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(code)}`,
        "/dev/null",
      ],
      { encoding: "utf8", timeout: 8000 },
    );
    expect(output).toContain('"timedOut":true');
    expect(output).toContain('"signal":"SIGTERM"');
  },
);
