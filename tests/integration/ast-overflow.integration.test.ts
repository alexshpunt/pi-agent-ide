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
  "Codemode reads the exact text while direct reads keep the overflow outline ($name)",
  async ({ name, body }) => {
    const root = path.resolve(".tmp/ast-overflow");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "contract-"));
    const source = `function checkout() {\n${body}}\n`;
    const rows = Array.from({ length: 2500 }, (_, id) => ({ id, name: `row ${id}` }));
    const window = source.split("\n").slice(1, 4).join("\n");
    try {
      await writeFile(path.join(cwd, "large.ts"), source);
      await writeFile(path.join(cwd, "large.json"), JSON.stringify(rows, null, 2));
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
        tools: ["read", "write", "codemode"],
        conversation: [
          call("full", "read", { path: "large.ts" }),
          call("json", "read", { path: "large.json" }),
          call("bounded", "read", { path: "large.ts", offset: 2, limit: 3 }),
          call("script", "codemode", {
            code: String.raw`
const strip = (value) => value.replace(/^<system-result[^\n]*\n/u, "");
const source = strip(await tools.read({ path: "large.ts" }));
await tools.write({ path: "copy.ts", content: source });
const json = strip(await tools.read({ path: "large.json" }));
const rows = JSON.parse(json);
await tools.write({ path: "copy.json", content: json });
const page = await tools.read({ path: "large.ts", offset: 2, limit: 3 });
if (!page.includes(${JSON.stringify(window)}) || !page.includes("more lines in source"))
  throw Error("Expected an explicit page with its continuation");
text(JSON.stringify({ sourceLength: source.length, rows: rows.length }));
`,
          }),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Read the large file directly and with Codemode, then inspect the exact bounded source.",
      );
      for (const id of ["full", "json"])
        expect(getToolExecutionDetails(getToolExecution(run, id))).toMatchObject({
          resolvedBy: "ast-overflow",
        });
      expect(getToolResultText(run, "full")).toContain("function checkout");
      expect(getToolExecutionResult(run, "full")).not.toHaveProperty("structuredContent");
      const bounded = getToolResultText(run, "bounded");
      expect(bounded).toContain(window);
      expect(getToolExecutionResult(run, "bounded")).not.toHaveProperty("structuredContent");
      expect(getToolExecution(run, "script").isError).toBe(false);
      const scriptText = getToolResultText(run, "script");
      expect(scriptText).toContain(`"sourceLength":${source.length}`);
      expect(scriptText).toContain(`"rows":${rows.length}`);
      expect(scriptText).not.toContain("Code overview");
      expect((await readFile(path.join(cwd, "copy.ts"), "utf8")) === source).toBe(true);
      expect(
        (await readFile(path.join(cwd, "copy.json"), "utf8")) === JSON.stringify(rows, null, 2),
      ).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
