import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { PiRun } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const marker = "LPT666_FILE_BODY_";
const largeContent = Array.from(
  { length: 400 },
  (_, index) => `${marker}${index.toString().padStart(4, "0")}_${"x".repeat(128)}\n`,
).join("");
const writeArgs = JSON.stringify({ path: "large.txt", content: largeContent });

async function runScript(cwd: string, name: string, code: string, extraExtensions: string[] = []) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noAnimations: true }),
  );
  const run = await new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: false,
    isolateUserResources: true,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode", ...extraExtensions],
    tools: ["codemode", "write"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "parent",
            name: "codemode",
            arguments: { code },
            chunks: { kind: "fixed", size: 1_000_000 },
            delayMs: 0,
          }),
        ],
        {
          stopReason: "toolUse",
        },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Run the script, then finish");
  expect(run.providerRequests).toHaveLength(2);
  // Keep the exact captured following provider context for offline inspection.
  await writeFile(
    path.join(run.artifacts.directory, "following-provider-request.json"),
    JSON.stringify(run.providerRequests[1], null, 2),
  );
  return run;
}

type Run = Awaited<ReturnType<typeof runScript>>;
function followingMessages(run: Run) {
  return run.providerRequests[1]?.messages as {
    role: string;
    toolCallId?: string;
    details?: unknown;
    nestedCalls?: unknown;
    content: { type: string; text?: string; name?: string; arguments?: { code?: string } }[];
  }[];
}
function followingResultText(run: Run, includeGuides = true) {
  const results = followingMessages(run).filter((message) => message.role === "toolResult");
  expect(results).toHaveLength(1);
  expect(results[0]?.toolCallId).toBe("parent");
  return results
    .flatMap((message) => message.content)
    .filter((block) => includeGuides || !block.text?.startsWith("\n\n---\n\n# Guide:"))
    .map((block) => block.text ?? "")
    .join("\n");
}
function assertScriptArguments(run: Run, code: string) {
  const assistant = followingMessages(run).find((message) => message.role === "assistant");
  expect(assistant?.content.find((block) => block.name === "codemode")?.arguments?.code).toBe(code);
  expect(JSON.stringify(run.providerRequests[0])).not.toContain(marker);
}

async function savedPanels(run: Run) {
  const saved = await PiRun.open(run.artifacts.run);
  const entries = (saved.session ?? "")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          customType?: string;
          data?: { calls: { name: string; result: { content: { text: string }[] } }[] };
        },
    );
  const panel = entries.find((entry) => entry.customType === "ide-nested-results");
  return panel?.data?.calls;
}

test("the silent Write capability checks real parent output", async () => {
  await withTempWorkspace(async (cwd) => {
    const task = capabilityCases.find((candidate) => candidate.id === "write-silent");
    if (!task) throw Error("Missing silent Write capability case");
    const run = await runScript(
      cwd,
      "write-context-capability",
      `await tools.write(${JSON.stringify(task.steps[0]?.args)});`,
    );
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
    expect(await readFile(path.join(cwd, "silent.txt"), "utf8")).toBe(
      task.expected?.["silent.txt"],
    );
  });
});
test("silent Write keeps large file content out of the following provider result", async () => {
  await withTempWorkspace(async (cwd) => {
    const baselineCode = `const planned = ${writeArgs}; void planned;`;
    const baseline = await runScript(cwd, "write-context-baseline", baselineCode);
    const code = `await tools.write(${writeArgs});`;
    const run = await runScript(cwd, "write-context-silent", code);
    expect(getToolExecution(run, "parent").isError).toBe(false);
    expect(await readFile(path.join(cwd, "large.txt"), "utf8")).toBe(largeContent);
    assertScriptArguments(baseline, baselineCode);
    assertScriptArguments(run, code);
    expect(followingResultText(baseline)).not.toContain(marker);
    expect(followingResultText(run)).not.toContain(marker);
    // Progressive tool guides are separate context, not written file content.
    expect(followingResultText(run, false).length).toBeLessThan(2000);
    // Native SDK metadata retains a short argument preview, not a second result body.
    const metadata = followingMessages(run).find((message) => message.role === "toolResult");
    expect(JSON.stringify(metadata?.details).length).toBeLessThan(2000);
    expect(JSON.stringify(metadata?.nestedCalls)).not.toContain(marker);
    expect(getToolResultMessage(run, "parent").nestedCalls?.calls).toHaveLength(1);
    const panels = await savedPanels(run);
    expect(panels).toHaveLength(1);
    expect(panels?.[0]?.name).toBe("write");
    expect(JSON.stringify(panels)).toContain(marker);
    expect(run.tuiRenderedOutput).toContain("write");
    expect(run.tuiRenderedOutput).toContain("+400 ~0 -0");
  });
});

test("explicit Write output reaches the provider once and respects Codemode truncation", async () => {
  await withTempWorkspace(async (cwd) => {
    const code = `// @options: {"max_output_tokens":1000}\ntext(await tools.write(${writeArgs}));`;
    const run = await runScript(cwd, "write-context-explicit-truncated", code);
    expect(getToolExecution(run, "parent").isError).toBe(false);
    assertScriptArguments(run, code);
    const output = followingResultText(run, false);
    expect(output).toContain(marker + "0000_");
    expect(output).not.toContain(marker + "0200_");
    expect(output).toMatch(/truncated/iu);
    expect(output.length).toBeLessThan(6000);
    expect(await readFile(path.join(cwd, "large.txt"), "utf8")).toBe(largeContent);
    expect(await savedPanels(run)).toHaveLength(1);
  });
});

test.each(["text", "return"])(
  "explicit %s delivers the Write result exactly once",
  async (delivery) => {
    await withTempWorkspace(async (cwd) => {
      const content = marker + "positive_control\n";
      const call = `await tools.write(${JSON.stringify({ path: "small.txt", content })})`;
      const code = delivery === "text" ? `text(${call});` : `return ${call};`;
      const run = await runScript(cwd, `write-context-${delivery}`, code);
      expect(getToolExecution(run, "parent").isError).toBe(false);
      expect(followingResultText(run).split(content)).toHaveLength(2);
      expect(await readFile(path.join(cwd, "small.txt"), "utf8")).toBe(content);
      expect(await savedPanels(run)).toHaveLength(1);
    });
  },
);
test("silent Write keeps syntax and recovery notices without its file body", async () => {
  await withTempWorkspace(async (cwd) => {
    const code = `await tools.write(${JSON.stringify({ path: "notice.note", content: largeContent })});`;
    const run = await runScript(cwd, "write-context-notices", code, [
      path.resolve("tests/integration/fixtures/write-context-notices.ts"),
    ]);
    const output = followingResultText(run);
    expect(output).toContain("Fixture recovery notice");
    expect(output).toContain("Fixture syntax problem");
    expect(output).toContain("Formatting failed");
    expect(output).not.toContain(marker);
    expect(await readFile(path.join(cwd, "notice.note"), "utf8")).toBe(largeContent);
    expect(JSON.stringify(await savedPanels(run))).toContain(marker);
  });
});
test("repeated silent Writes do not accumulate file bodies in provider output", async () => {
  await withTempWorkspace(async (cwd) => {
    const code = `await tools.write(${writeArgs}); await tools.write(${writeArgs}); await tools.write(${JSON.stringify({ path: "large.txt", content: largeContent + "tail\n" })});`;
    const run = await runScript(cwd, "write-context-repeated", code);
    expect(getToolExecution(run, "parent").isError).toBe(false);
    assertScriptArguments(run, code);
    expect(followingResultText(run)).not.toContain(marker);
    expect(getToolResultMessage(run, "parent").nestedCalls?.calls).toHaveLength(3);
    expect(await savedPanels(run)).toHaveLength(3);
    expect(await readFile(path.join(cwd, "large.txt"), "utf8")).toBe(largeContent + "tail\n");
  });
});

test("a failed Write keeps recovery output without copying earlier successful file content", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, "directory"));
    const code = `await tools.write(${writeArgs}); await tools.write({path:"directory",content:"blocked"});`;
    const run = await runScript(cwd, "write-context-error", code);
    expect(getToolExecution(run, "parent").isError).toBe(true);
    assertScriptArguments(run, code);
    expect(followingResultText(run)).toContain("directory");
    expect(followingResultText(run)).toMatch(/failed|error/iu);
    expect(followingResultText(run)).not.toContain(marker);
    expect(await readFile(path.join(cwd, "large.txt"), "utf8")).toBe(largeContent);
    expect(getToolResultMessage(run, "parent").nestedCalls?.calls).toHaveLength(2);
    expect(await savedPanels(run)).toHaveLength(2);
  });
});
