import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "./support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

interface ConstraintSnapshot {
  hostEntry: string;
  parameters: {
    properties: {
      query: { type: string; minLength: number };
      limit: { type: string; minimum: number; maximum: number };
    };
  };
  observed: {
    toolCallId: string;
    toolName: string;
    input: { query: string; limit: number };
  }[];
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
}

test("native direct and Codemode calls share host integer coercion and range validation", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    await writeFile(path.join(cwd, "example.txt"), "constraint-marker\n");
    const args = { path: "example.txt", query: "constraint-marker", limit: 1.5 };
    const code = [
      `const args = ${JSON.stringify(args)};`,
      "text(await tools.search(args).then(value => value.result));",
      "text(await tools.input_constraint_control(args));",
      "let rejected = false;",
      "try { await tools.search({ ...args, limit: 0 }); } catch { rejected = true; }",
      "text(JSON.stringify({ rejected }));",
    ].join("\n");
    const result = await new PiIntegrationTest({
      testName: "native-input-constraint-coercion",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/input-constraint-probe.ts"),
        "builtin:codemode",
      ],
      tools: ["search", "codemode", "input_constraint_control", "input_constraint_snapshot"],
      conversation: [
        call("search-direct", "search", args),
        call("control-direct", "input_constraint_control", args),
        call("nested", "codemode", { code }),
        call("invalid-direct", "search", { ...args, limit: 0 }),
        call("snapshot", "input_constraint_snapshot", {}),
        assistantMessage([text("Finished")]),
      ],
    }).run("Compare the real host validation path for IDE Search and an independent control");

    expect(getToolExecution(result, "search-direct").isError).toBe(false);
    expect(getToolExecution(result, "control-direct").isError).toBe(false);
    expect(getToolExecution(result, "nested").isError).toBe(false);
    expect(getToolExecution(result, "invalid-direct").isError).toBe(true);
    expect(getToolResultText(result, "search-direct")).toContain("constraint-marker");
    expect(getToolResultText(result, "nested")).toContain("constraint-marker");
    expect(getToolResultText(result, "nested")).toContain('"rejected":true');
    expect(JSON.parse(getToolResultText(result, "control-direct"))).toMatchObject({
      query: "constraint-marker",
      limit: 1,
    });

    const snapshot = JSON.parse(getToolResultText(result, "snapshot")) as ConstraintSnapshot;
    // Assert schema structure and observable arguments, never prompt/declaration wording.
    expect(snapshot.parameters.properties.query).toMatchObject({ type: "string", minLength: 1 });
    expect(snapshot.parameters.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 1000,
    });
    expect(snapshot.observed).toHaveLength(4);
    expect(snapshot.observed.filter((event) => event.toolName === "search")).toHaveLength(2);
    expect(
      snapshot.observed.filter((event) => event.toolName === "input_constraint_control"),
    ).toHaveLength(2);
    expect(
      snapshot.observed.filter((event) => event.toolCallId.startsWith("nested/")),
    ).toHaveLength(2);
    expect(snapshot.observed.every((event) => event.input.limit === 1)).toBe(true);
    expect(snapshot.observed.some((event) => event.toolCallId === "invalid-direct")).toBe(false);
  });
});
