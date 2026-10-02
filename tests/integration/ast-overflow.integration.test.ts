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
            code: 'const result = await tools.read({ path: "large.ts" }); const data = result.data; text({ status: result.status, kind: data?.kind, startLine: data?.startLine, endLine: data?.endLine, truncated: data?.truncated, continuation: data?.continuation, firstLine: data?.lines?.[0]?.content });',
          }),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Read the large file directly and with Codemode, then inspect the exact bounded source.",
      );
      expect(getToolExecutionDetails(getToolExecution(run, "full"))).toMatchObject({
        resolvedBy: "ast-overflow",
      });
      expect(getToolResultText(run, "full")).toContain("omitted bodies are not exact source text");
      const full = getToolExecutionResult(run, "full") as {
        structuredContent: {
          status: string;
          data: {
            kind: string;
            source: string;
            lines: { content: string; lineEnding: string }[];
            startLine: number;
            endLine: number;
            totalLines: number;
            truncated: boolean;
            continuation?: { path: string; offset: number };
          };
        };
      };
      expect(full.structuredContent.status).toBe("success");
      const data = full.structuredContent.data;
      expect(data).toMatchObject({
        kind: "text",
        startLine: 1,
        totalLines: source.trimEnd().split("\n").length,
      });
      expect(data.lines.map((line) => line.content + line.lineEnding).join("")).toBe(
        source.split("\n").slice(0, data.endLine).join("\n") + "\n",
      );
      expect(data.truncated).toBe(name === "lines");
      if (name === "lines") expect(data.continuation).toEqual({ path: data.source, offset: 2001 });
      else expect(data.continuation).toBeUndefined();
      const bounded = getToolExecutionResult(run, "bounded") as { structuredContent: unknown };
      expect(bounded.structuredContent).toMatchObject({
        status: "success",
        data: { kind: "text", startLine: 2, endLine: 4, truncated: false },
      });
      expect(getToolExecution(run, "script").isError).toBe(false);
      const scriptText = getToolResultText(run, "script");
      expect(scriptText).toContain('"status":"success"');
      expect(scriptText).toContain('"kind":"text"');
      expect(scriptText).toContain('"firstLine":"function checkout() {"');
      expect(scriptText).toContain(`"endLine":${data.endLine}`);
      expect(scriptText).toContain(`"truncated":${data.truncated}`);
      expect(scriptText).not.toContain("STRUCTURED_ADAPTER_REQUIRED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
