import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test.each([true, false])(
  "obsolete disabled IDs do not prevent Apply startup; LSP disabled=%s",
  async (disabled) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["removed.module", ...(disabled ? ["ide.lsp"] : [])] }),
      );
      await writeFile(path.join(cwd, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
      await writeFile(path.join(cwd, "source.ts"), "export class Example {}\n");
      const run = await new PiIntegrationTest({
        testName: `module-lsp-${disabled ? "off" : "on"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["apply"],
        timeoutMs: 120_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "probe",
                name: "apply",
                arguments: {
                  source: `
const file = read({path: "source.ts"});
if (!file.content.includes("Example")) throw new Error("Ordinary read unavailable");
let available = false;
try { const symbol = read({path: "symbol:source.ts#Example"}); available = symbol.content.includes("Example"); } catch {}
if (available !== ${!disabled}) throw new Error("Wrong LSP module state");
`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Check module selection through actual tools");
      const execution = getToolExecution(run, "probe");
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    });
  },
);

test.each([
  { disabled: true, mode: "module" },
  { disabled: false, mode: "module" },
  { disabled: true, mode: "flag" },
  { disabled: false, mode: "flag" },
])("formatter respects $mode selection: disabled=$disabled", async ({ disabled, mode }) => {
  await withTempWorkspace(async (cwd) => {
    const config = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, "extensions.json"),
      JSON.stringify(
        mode === "module"
          ? { disabled: disabled ? ["ide.formatter"] : [] }
          : { flags: { "pi-agent-ide-no-post-processing": disabled } },
      ),
    );
    const formatter = path.join(cwd, "formatter.mjs");
    await writeFile(
      formatter,
      'import {readFile,writeFile} from "node:fs/promises"; const p=process.argv[2]; await writeFile(p,(await readFile(p,"utf8")).replace("value=2", "value = 2"));',
    );
    await writeFile(
      path.join(config, "formatters.json"),
      JSON.stringify({
        version: 1,
        formatters: {
          fixture: {
            extensions: [".fixture"],
            run: { command: ["node", formatter, "{file}"] },
            output: "in-place",
          },
        },
      }),
    );
    const run = await new PiIntegrationTest({
      testName: `${mode}-format-${disabled ? "off" : "on"}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "format",
              name: "apply",
              arguments: {
                source: 'write({path:"note.fixture",content:"value=2\\n"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Verify configured formatter is actually invoked only when enabled");
    const execution = getToolExecution(run, "format");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    await expect(readFile(path.join(cwd, "note.fixture"), "utf8")).resolves.toBe(
      disabled ? "value=2\n" : "value = 2\n",
    );
  });
});

test.each([true, false])("Apply can be disabled independently: %s", async (disabled) => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ flags: { "pi-agent-ide-no-apply": disabled } }),
    );
    const probe = path.join(cwd, "probe.ts");
    await writeFile(
      probe,
      `import { writeFile } from "node:fs/promises";
export default function(pi) { pi.on("session_start", async () => {
  const names = pi.getAllTools().map(tool => tool.name);
  if (names.includes("apply") !== ${!disabled}) throw new Error("Wrong Apply registration");
  for (const name of ["read", "search", "replace", "copy_file", "diff"]) if (!names.includes(name)) throw new Error("Missing standalone tool: " + name);
  await writeFile(${JSON.stringify(path.join(cwd, "verified.txt"))}, "verified");
}); }`,
    );
    const run = await new PiIntegrationTest({
      testName: `apply-setting-${disabled}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), probe],
      tools: ["read"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "verify", name: "read", arguments: { path: "verified.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the successful tool registration check");
    const execution = getToolExecution(run, "verify");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
  });
});
