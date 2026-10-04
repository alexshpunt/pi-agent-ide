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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

test.each([true, false])(
  "obsolete disabled IDs do not prevent native startup; LSP disabled=%s",
  async (disabled) => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
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
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["codemode", "read", "write"],
        timeoutMs: 120_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "probe",
                name: "codemode",
                arguments: {
                  code: `
const file = await tools.read({path: "source.ts"});
if(file.status!=="success"||!file.data.lines.some(line=>line.content.includes("Example"))) throw Error(JSON.stringify(file));
let available = false;
try { const symbol=await tools.read({path:"symbol:source.ts#Example"}); available=symbol.status==="success"; } catch {}
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
    await enableNativeCodemode(cwd);
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
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "write"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "format",
              name: "codemode",
              arguments: {
                code: 'const written=await tools.write({path:"note.fixture",content:"value=2\\n"}); if(written.status!=="success") throw Error(JSON.stringify(written)); text(written);',
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

test("normal registration has native tools but no Apply tool", async () => {
  await withTempWorkspace(async (cwd) => {
    const probe = path.join(cwd, "probe.ts");
    await writeFile(
      probe,
      `import { writeFile } from "node:fs/promises";
import path from "node:path";
export default function(pi) { pi.on("session_start", async (_event, context) => {
  const names = pi.getAllTools().map(tool => tool.name);
  if(names.includes("apply")) throw Error("Removed Apply tool is registered");
  for (const name of ["read", "search", "replace", "copy", "move", "delete", "diff"]) if (!names.includes(name)) throw new Error("Missing standalone tool: " + name);
  for (const name of ["copy_file", "move_file", "delete_file"]) if (names.includes(name)) throw new Error("Obsolete standalone tool: " + name);
  await writeFile(path.join(context.cwd, "verified.txt"), "verified");
}); }`,
    );
    const run = await new PiIntegrationTest({
      testName: "native-registration-without-apply",
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
