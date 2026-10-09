import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary structural search executes remotely and edits its shared SEARCH ranges", async () => {
  const binary =
    process.env.PI_IDE_AST_GREP_BINARY ??
    (await promisify(execFile)("which", ["ast-grep"])).stdout.trim();
  const fixture = await startSshFixture({ "ast-grep": binary });
  const base = path.resolve(".tmp/ssh-ast-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const scope = `ssh://fixture${fixture.workspace}`;
  const note = `${scope}/note.ts`;
  try {
    await backend.write(
      path.join(fixture.workspace, "note.ts"),
      Buffer.from('const label = "café"; console.log(label);\n'),
      null,
    );
    const outlineFile = `${scope}/outline.ts`;
    await backend.write(
      path.join(fixture.workspace, "outline.ts"),
      Buffer.from(
        'export function greet() {\n  const label = "café";\n  const count = 1;\n  return label + count;\n}\n',
      ),
      null,
    );
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
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
      testName: "ssh-ast-selections",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/ssh-search.ts"),
        "builtin:codemode",
      ],
      tools: ["search", "replace", "read", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "search",
            name: "search",
            arguments: { query: "ast:console.log($VALUE)", path: note },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "replace-search",
            name: "replace",
            arguments: { start: "SEARCH#0000:all:match", text: "console.info(label)" },
          }),
        ]),
        assistantMessage([toolCall({ id: "read", name: "read", arguments: { path: note } })]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `const r = await tools.search({query: "ast:console.info($VALUE)", path: ${JSON.stringify(scope)}}); if (!r.includes(${JSON.stringify(note)}) || !r.includes("console.info(label)")) throw new Error(r); text(r);`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "scopes",
            name: "read",
            arguments: { path: outlineFile, views: ["ast"] },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "outline", name: "read", arguments: { path: `ast:${outlineFile}` } }),
        ]),
        assistantMessage([
          toolCall({
            id: "unknown-outline",
            name: "read",
            arguments: { path: "ast:ssh://unknown/tmp/outline.ts" },
          }),
        ]),
        assistantMessage([text("Verified.")]),
      ],
    }).run("Use ordinary structural search and replace on the SSH scope.");
    for (const id of ["search", "replace-search", "read", "structured", "scopes", "outline"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "search")).toContain(note);
    expect(getToolExecution(run, "unknown-outline").isError).toBe(true);
    expect(getToolResultText(run, "unknown-outline")).toContain("UNKNOWN_TARGET");
    expect(getToolResultText(run, "scopes")).toContain("scope-begin-");
    expect(getToolResultText(run, "outline")).toContain(outlineFile);
    expect(getToolResultText(run, "outline")).not.toContain(`${cwd}/ssh:`);
    expect(getToolResultText(run, "read")).toContain('const label = "café"; console.info(label);');
    expect(getToolResultText(run, "replace-search")).toContain("Matches: 0");
    expect(getToolResultText(run, "structured")).not.toContain("Script error:");
    expect(run.tuiRenderedOutput).toContain(note);
    expect(run.tuiRenderedOutput).toContain("console.log");
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
