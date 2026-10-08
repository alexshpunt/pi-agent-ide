import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("real Pi reports restored paths and a cleanup warning instead of not changed", async () => {
  await mkdir(path.resolve(".tmp/undo-cleanup-tests"), { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/undo-cleanup-tests/workspace-"));
  const file = path.join(cwd, "cleanup-owned.txt");
  try {
    await writeFile(file, "before");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.lsp",
          "ide.formatter",
          "ide.lint",
          "ide.diagnostics",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "undo-cleanup-warning",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/undo-cleanup.ts"),
        "builtin:codemode",
      ],
      tools: ["apply", "undo", "read", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "apply",
            name: "apply",
            arguments: {
              source: `const f = open(${JSON.stringify(file)}); f.replace(f.find("before"), "after");`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "undo", name: "undo", arguments: { transaction: "APPLY#000000000000" } }),
        ]),
        assistantMessage([toolCall({ id: "read", name: "read", arguments: { path: file } })]),
        assistantMessage([
          toolCall({
            id: "apply-structured",
            name: "apply",
            arguments: {
              source: `const f = open(${JSON.stringify(file)}); f.replace(f.find("before"), "after");`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured-undo",
            name: "codemode",
            arguments: {
              code: `const result = await tools.undo({transaction: "APPLY#000000000000"}); if (result.status !== "error" || result.data.effect !== "applied" || result.errors.length !== 1 || result.errors[0].code !== "APPLY_UNDO_CLEANUP_FAILED" || result.data.files.length !== 1 || result.data.files[0].source !== ${JSON.stringify(file)}) throw new Error(JSON.stringify(result)); text(result);`,
            },
          }),
        ]),
        assistantMessage([text("Verified.")]),
      ],
    }).run("Edit and undo the owned file, retaining a truthful cleanup warning.");
    expect(getToolResultMessage(run, "undo").details).toMatchObject({ effect: "applied" });
    expect(getToolResultText(run, "undo")).toContain("Paths restored");
    expect(getToolResultText(run, "undo")).toContain("APPLIED_WITH_ERROR");
    expect(getToolResultText(run, "undo")).not.toContain("No file was changed.");
    expect(getToolResultText(run, "structured-undo")).toContain('"effect":"applied"');
    expect(getToolResultText(run, "structured-undo")).not.toContain("Script error:");
    expect(getToolResultText(run, "read")).toContain("before");
    expect(await readFile(file, "utf8")).toBe("before");
    const terminal = run.tuiRenderedOutput;
    expect(terminal).toContain("Applied · journal cleanup failed");
    expect(terminal).not.toContain("Not changed · edit failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
