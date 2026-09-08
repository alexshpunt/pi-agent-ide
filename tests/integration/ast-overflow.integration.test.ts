import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolExecutionDetails,
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
