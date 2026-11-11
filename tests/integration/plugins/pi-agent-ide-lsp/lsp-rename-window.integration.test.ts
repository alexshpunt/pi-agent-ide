import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const SOURCE = 'export function greet() { return "greet"; }\n';
const USAGE = 'import { greet } from "./source";\nexport const answer = greet();\n';

/**
 * Rename `greet` through the TypeScript language server while another session writes `file`
 * once, after the rename is planned and before it is written.
 */
async function renameInWindow(
  cwd: string,
  testName: string,
  write: { file: string; prepend?: string; append?: string; replace?: [string, string] },
) {
  await mkdir(path.join(cwd, ".tmp/edit-window"), { recursive: true });
  await writeFile(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await writeFile(path.join(cwd, "source.ts"), SOURCE);
  await writeFile(path.join(cwd, "usage.ts"), USAGE);
  await writeFile(path.join(cwd, ".tmp/edit-window/write.json"), JSON.stringify(write));
  const run = await new PiIntegrationTest({
    testName,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: false,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      path.resolve("tests/integration/fixtures/write-in-edit-window.ts"),
    ],
    tools: ["replace"],
    timeoutMs: 120_000,
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "rename",
            name: "replace",
            arguments: { path: "symbol:source.ts#greet#name", text: "welcome" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done.")]),
    ],
  }).run("Rename greet while another session writes a participant");
  const afterPlan = await access(path.join(cwd, ".tmp/edit-window/after-plan")).then(
    () => true,
    () => false,
  );
  return {
    output: getToolResultText(run, "rename"),
    isError: getToolExecution(run, "rename").isError,
    afterPlan,
    source: await readFile(path.join(cwd, "source.ts"), "utf8"),
    usage: await readFile(path.join(cwd, "usage.ts"), "utf8"),
  };
}

test("a rename succeeds when another session adds lines to a participant after its plan", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await renameInWindow(cwd, "lsp-rename-window-prepend", {
      file: "usage.ts",
      prepend: "// peer one\n// peer two\n",
    });

    expect(result.isError, result.output).toBe(false);
    expect(result.afterPlan).toBe(true);
    expect(result.source).toBe('export function welcome() { return "greet"; }\n');
    expect(result.usage).toBe(
      '// peer one\n// peer two\nimport { welcome } from "./source";\nexport const answer = welcome();\n',
    );
  });
});

test("a rename also renames a reference that another session added after its plan", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await renameInWindow(cwd, "lsp-rename-window-new-reference", {
      file: "usage.ts",
      append: "export const again = greet();\n",
    });

    expect(result.isError, result.output).toBe(false);
    expect(result.afterPlan).toBe(true);
    expect(result.usage).toBe(
      'import { welcome } from "./source";\nexport const answer = welcome();\nexport const again = welcome();\n',
    );
  });
});

test("a rename writes nothing when another session renamed the symbol after its plan", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await renameInWindow(cwd, "lsp-rename-window-symbol-gone", {
      file: "source.ts",
      replace: ["function greet", "function hello"],
    });

    expect(result.isError).toBe(true);
    expect(result.afterPlan).toBe(true);
    expect(result.source).toBe('export function hello() { return "greet"; }\n');
    expect(result.usage).toBe(USAGE);
  });
});
