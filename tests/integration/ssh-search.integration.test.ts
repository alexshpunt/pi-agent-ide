import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

test("ordinary search retains SSH identities, recipes, selections and file scopes", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-search-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const scope = `ssh://fixture${fixture.workspace}`;
  const note = `${scope}/note.txt`;
  const dash = `${scope}/-`;
  try {
    await backend.write(
      path.join(fixture.workspace, "note.txt"),
      Buffer.from("café needle\nneedle second\n"),
      null,
    );
    await backend.write(
      path.join(fixture.workspace, "excluded.txt"),
      Buffer.from("needle excluded\n"),
      null,
    );
    await backend.write(path.join(fixture.workspace, "-"), Buffer.from("dash-marker\n"), null);
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
      testName: "ssh-search-selections",
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
            arguments: { query: "needle", path: scope, include: "note.txt" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "replace-search",
            name: "replace",
            arguments: { start: "SEARCH#0000:all:match", text: "changed" },
          }),
        ]),
        assistantMessage([toolCall({ id: "read", name: "read", arguments: { path: note } })]),
        assistantMessage([
          toolCall({
            id: "boolean",
            name: "search",
            arguments: { query: "changed AND second", path: scope },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "regex",
            name: "search",
            arguments: { query: "regex:changed", path: note },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "files",
            name: "search",
            arguments: { query: "files:*.txt", path: scope, exclude: "excluded.txt" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "unknown",
            name: "search",
            arguments: { query: "needle", path: "ssh://unknown/tmp" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `const r = await tools.search({query: "changed", path: ${JSON.stringify(note)}}); if (!r.includes(${JSON.stringify(note)}) || !r.includes("changed")) throw new Error(r); text(r);`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "dash-file",
            name: "search",
            arguments: { query: "dash-marker", path: dash },
          }),
        ]),
        assistantMessage([text("Verified.")]),
      ],
    }).run("Use ordinary search and replace on the configured SSH scope.");
    for (const id of [
      "search",
      "replace-search",
      "read",
      "boolean",
      "regex",
      "files",
      "structured",
      "dash-file",
    ])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(getToolExecution(run, "unknown").isError).toBe(true);
    expect(getToolResultText(run, "unknown")).toContain("UNKNOWN_TARGET");
    expect(getToolResultText(run, "search")).toContain(note);
    expect(getToolResultText(run, "dash-file")).toContain(dash);
    expect(getToolResultText(run, "read")).toContain("café changed");
    expect(getToolResultText(run, "replace-search")).toContain(
      "Original search observed after editing",
    );
    expect(getToolResultText(run, "replace-search")).toContain("Matches: 0");
    expect(getToolResultText(run, "boolean")).toContain("⟦changed⟧ second");
    expect(getToolResultText(run, "files")).toContain(note);
    expect(getToolResultText(run, "files")).not.toContain("excluded.txt");
    expect(getToolResultText(run, "structured")).not.toContain("Script error:");
    expect(run.tuiRenderedOutput).toContain("changed");
    expect(
      (await backend.read(path.join(fixture.workspace, "note.txt"))).bytes.toString("utf8"),
    ).toBe("café changed\nchanged second\n");
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
