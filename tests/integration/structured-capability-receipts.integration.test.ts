import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { capabilityCases } from "#capabilities/cases.ts";
import { parseEvents, resultText, validateRoute } from "#capabilities/validation.ts";
import { expect, test } from "vitest";

test("the structured capability case proves real alias receipts without exposing its nonce in summary text", async () => {
  await withTempWorkspace(async (cwd) => {
    const task = capabilityCases.find(
      (candidate) => candidate.id === "semantic-local-alias-receipts",
    );
    if (!task) throw new Error("Missing structured receipt capability case");
    const textTask = capabilityCases.find(
      (candidate) => candidate.id === "semantic-write-receipts",
    );
    if (!textTask) throw new Error("Missing existing text receipt capability case");
    await writeFile(path.join(cwd, "task.txt"), "keep\nOLD\nlast\n");
    const run = await new PiIntegrationTest({
      testName: "capability-structured-alias-receipts",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      timeoutMs: 120_000,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/structured-insert-alias.ts"),
        path.resolve("benchmarks/tool-capabilities/semantic-write-fixture.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/capability-tui-mirror.ts"),
      ],
      tools: ["insert", "mcp__agent_ide__insert", "write", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "receipts",
              name: "codemode",
              arguments: {
                code: 'for (const effect of ["applied","not-applied","unknown"]) { const receipt = await tools.mcp__agent_ide__insert({path:"fixture:semantic-script/"+effect,text:"probe"}); text(receipt); } for (const effect of ["applied","not-applied","unknown"]) { try { const receipt = await tools.write({path:"fixture:semantic/"+effect,content:"probe"}); text({legacyKind:typeof receipt}); } catch { text({legacyRefused:effect}); } }',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Unknown remains unknown; no action was replayed.")]),
      ],
    }).run("Preserve synthetic structured receipts through the local alias");
    expect(getToolExecution(run, "receipts").isError, getToolResultText(run, "receipts")).toBe(
      false,
    );
    const events = parseEvents(await readFile(path.join(cwd, "public-events.jsonl"), "utf8"));
    expect(validateRoute(task, events, "codemode", { mcp__agent_ide__insert: "insert" })).toEqual({
      passed: true,
      reasons: [],
    });
    expect(validateRoute(textTask, events, "codemode")).toEqual({
      passed: true,
      reasons: [],
    });
    expect(getToolResultText(run, "receipts")).toContain('"legacyKind":"string"');
    const sourceResults = events.filter(
      (event) => event.type === "tool_execution_end" && event.toolName === "insert",
    );
    expect(sourceResults).toHaveLength(3);
    for (const event of sourceResults) {
      const value = event.result?.structuredContent;
      if (
        !value ||
        typeof value !== "object" ||
        !("nonce" in value) ||
        typeof value.nonce !== "string"
      )
        throw new Error("The real source result has no nonce-bearing structured receipt");
      expect(value.nonce).toMatch(/^[a-f\d-]{36}$/u);
      expect(resultText(event)).not.toContain(value.nonce);
    }
    const textResults = events.filter(
      (event) => event.type === "tool_execution_end" && event.toolName === "write",
    );
    expect(textResults).toHaveLength(3);
    expect(textResults.every((event) => event.result?.structuredContent === undefined)).toBe(true);
    expect(await readFile(path.join(cwd, "attempts.jsonl"), "utf8")).toBe(
      [task.expected?.["attempts.jsonl"], textTask.expected?.["attempts.jsonl"]].join(""),
    );
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nOLD\nlast\n");
  });
});
