import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("ordinary SSH writes run the owner formatter and reread its final content", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-formatter-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const root = `ssh://fixture${fixture.workspace}`;
  const source = `${root}/note.fixture`;
  try {
    await backend.write(
      `${fixture.workspace}/.pi/pi-agent-ide/formatters.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          formatters: {
            owned: {
              extensions: [".fixture"],
              run: {
                command: [
                  "python3",
                  "-c",
                  "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text().upper(),end='')",
                  "{file}",
                ],
              },
              output: "stdout",
            },
          },
        }),
      ),
      null,
    );
    await backend.write(
      `${fixture.workspace}/.pi/pi-agent-ide/linters.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          linters: {
            owned: {
              extensions: [".fixture"],
              check: {
                command: [
                  "python3",
                  "-c",
                  "import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); print(json.dumps({'diagnostics':[{'file':str(p),'line':1,'column':1,'severity':'warning','message':'Owned lint '+p.read_text().strip()}]}))",
                  "{file}",
                ],
              },
              diagnostics: { format: "pi-json" },
            },
          },
        }),
      ),
      null,
    );
    await backend.write(
      `${fixture.workspace}/server.py`,
      await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
      null,
    );
    await backend.write(
      `${fixture.workspace}/.pi/pi-agent-ide/lsp-servers.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          servers: {
            owned: {
              command: ["python3", "{project}/server.py"],
              rootMarkers: [],
              languages: { fixture: { extensions: [".fixture"] } },
              capabilities: ["diagnostics"],
            },
          },
        }),
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
        noPostProcessing: false,
        disabled: ["ide.ast", "ide.debugger", "ide.terminal", "ide.vision"],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-formatter-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "write",
            name: "write",
            arguments: { path: source, content: "before\n" },
          }),
        ]),
        assistantMessage([toolCall({ id: "read", name: "read", arguments: { path: source } })]),
        // Diagnostics can honestly be pending; wait through the public interface for this revision.
        assistantMessage([
          toolCall({
            id: "diagnostics-ready",
            name: "codemode",
            arguments: {
              code: `const deadline=Date.now()+10000; let ready=false; for(let attempt=0;attempt<20 && Date.now()<deadline;attempt++){ const result=await tools.read({path:${JSON.stringify(`diagnostics:${source}`)}}); if(JSON.stringify(result).includes("Owned lint BEFORE")){text(result);ready=true;break;} } if(!ready) throw new Error("Owned lint did not complete for the saved revision");`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "diagnostics",
            name: "read",
            arguments: { path: `diagnostics:${source}` },
          }),
        ]),
        assistantMessage([text("Verified owner formatting.")]),
      ],
    }).run("Write and inspect the owned file after its formatter runs.");
    expect(getToolExecution(run, "write").isError).toBe(false);
    expect(getToolResultText(run, "write")).toContain("BEFORE");
    expect(getToolResultText(run, "read")).toContain("BEFORE");
    expect(getToolExecution(run, "diagnostics-ready").isError).toBe(false);
    expect(getToolResultText(run, "diagnostics-ready")).toContain("Owned lint BEFORE");
    expect(getToolExecution(run, "diagnostics").isError).toBe(false);
    expect(getToolResultText(run, "diagnostics")).toContain("Owned lint BEFORE");
    expect(getToolResultText(run, "diagnostics")).not.toContain("No files found to lint");
    expect((await backend.read(`${fixture.workspace}/note.fixture`)).bytes.toString("utf8")).toBe(
      "BEFORE\n",
    );
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 70000);
