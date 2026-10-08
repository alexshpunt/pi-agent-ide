import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("overflow overview preserves source coordinates for a later exact edit", async () => {
  const root = path.resolve(".agents/tmp/ast-overflow");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "integration-"));
  const source = `function checkout() {\n${"  consume(value);\n".repeat(2100)}}\n`;
  try {
    await writeFile(path.join(cwd, "large.ts"), source);
    await writeFile(path.join(cwd, "flat.ts"), "import 'package';\n".repeat(2100));
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ noAnimations: true, noPostProcessing: true }),
    );
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const result = await new PiIntegrationTest({
      testName: "ast-overflow",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "insert"],
      conversation: [
        call("overview", "read", { path: "large.ts" }),
        call("flat", "read", { path: "flat.ts" }),
        call("window", "read", { path: "large.ts", offset: 2100, limit: 3, views: ["anchors"] }),
        call("edit", "insert", {
          path: "large.ts",
          anchor: "}",
          before: true,
          text: "  finish();\n",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run(
      "Inspect the large file, read its final three lines and insert finish() before its closing brace.",
    );
    expect(getToolExecutionDetails(getToolExecution(result, "overview"))).toMatchObject({
      resolvedBy: "ast-overflow",
    });
    expect(getToolResultText(result, "overview")).toContain("2102 | }");
    expect(getToolExecutionDetails(getToolExecution(result, "flat"))).toMatchObject({
      resolvedBy: "ast-overflow",
    });
    expect(getToolResultText(result, "flat").length).toBeLessThan(1000);
    expect(getToolExecutionDetails(getToolExecution(result, "window"))).toMatchObject({
      startLine: 2100,
      endLine: 2102,
    });
    expect(getToolExecution(result, "edit").isError).toBe(false);
    expect(await readFile(path.join(cwd, "large.ts"), "utf8")).toBe(
      source.replace("}\n", "  finish();\n}\n"),
    );
    await writeFile(path.join(root, "system-prompt.txt"), getProviderSystemPrompt(result));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

test.each([
  { name: "lines", body: "  consume(value);\n".repeat(2100) },
  { name: "bytes", body: `  consume("${"界".repeat(30)}");\n`.repeat(1000) },
])(
  "overflow keeps exact structured source data ($name)",
  async ({ name, body }) => {
    const root = path.resolve(".tmp/ast-overflow");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "contract-"));
    const source = `function checkout() {\n${body}}\n`;
    try {
      await writeFile(path.join(cwd, "large.ts"), source);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true, noPostProcessing: true }),
      );
      const call = (id: string, tool: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name: tool, arguments: args })], {
          stopReason: "toolUse",
        });
      const run = await new PiIntegrationTest({
        testName: `ast-overflow-contract-${name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "codemode"],
        conversation: [
          call("full", "read", { path: "large.ts" }),
          call("bounded", "read", { path: "large.ts", offset: 2, limit: 3 }),
          call("script", "codemode", {
            code: String.raw`
const result = await tools.read({ path: "large.ts" });
if (typeof result !== "string") throw Error("Expected readable overview");
const action = /Read ("(?:[^"\\]|\\.)*") with offset and limit for exact source text\./.exec(result);
if (!action) throw Error("Missing original-source recovery action");
const recovered = await tools.read({ path: JSON.parse(action[1]), offset: 2, limit: 3 });
if (!recovered.includes(${JSON.stringify(source.split("\n").slice(1, 4).join("\n"))}))
  throw Error("Recovery did not return the exact source window");
text(result);
text(recovered);
`,
          }),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Read the large file directly and with Codemode, then inspect the exact bounded source.",
      );
      expect(getToolExecutionDetails(getToolExecution(run, "full"))).toMatchObject({
        resolvedBy: "ast-overflow",
      });
      expect(getToolResultText(run, "full")).toContain("Some source text is omitted.");
      expect(getToolExecutionResult(run, "full")).not.toHaveProperty("structuredContent");
      const bounded = getToolResultText(run, "bounded");
      expect(bounded).toContain(source.split("\n").slice(1, 4).join("\n"));
      expect(getToolExecutionResult(run, "bounded")).not.toHaveProperty("structuredContent");
      expect(getToolExecution(run, "script").isError).toBe(false);
      const scriptText = getToolResultText(run, "script");
      expect(scriptText).toContain("Some source text is omitted.");
      expect(scriptText).toContain("function checkout");
      expect(scriptText).not.toContain('"kind":"text"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
