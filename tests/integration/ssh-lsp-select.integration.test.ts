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

test.each(["scope", "mutation"] as const)(
  "native SSH symbol targets keep exact %s authority",
  async (mode) => {
    const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
    const base = path.resolve(".tmp/ssh-lsp-select-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const root = `ssh://fixture${fixture.workspace}`;
    const source = 'const label = "café";\n';
    const local = path.join(cwd, "note.ts");
    try {
      await writeFile(local, source);
      for (const name of ["note.ts", "reference.ts"])
        await backend.write(`${fixture.workspace}/${name}`, Buffer.from(source), null);
      await backend.write(
        `${fixture.workspace}/server.py`,
        await readFile("tests/integration/fixtures/lsp-owner-server.py"),
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
                languages: { typescript: { extensions: [".ts"] } },
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
          noPostProcessing: true,
          disabled: [
            "ide.formatter",
            "ide.lint",
            "ide.debugger",
            "ide.terminal",
            "ide.vision",
            "ide.diagnostics",
          ],
        }),
      );
      const run = await new PiIntegrationTest({
        testName: `ssh-lsp-select-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "select", "search", "replace", "codemode"],
        timeoutMs: 90000,
        conversation: [
          assistantMessage([
            toolCall({
              id: "ordinary",
              name: "search",
              arguments: { query: "symbols:label", path: `${root}/note.ts` },
            }),
          ]),
          assistantMessage([
            toolCall({
              id: "scoped",
              name: "codemode",
              arguments: {
                code: `
const read = await tools.read({ path: ${JSON.stringify(`${root}/note.ts`)} });
const seed = await tools.select({ path: read, operation: { kind: "range", startLine: 1, startColumn: 6, endLine: 1, endColumn: 11 } });
if (seed.status !== "success") throw Error(JSON.stringify(seed));
const strict = await tools.search({ query: "symbols:label", path: seed });
if (strict.status !== "success" || strict.data.matches.length !== 1 || strict.data.matches[0]?.role !== "definition" || strict.data.matches[0]?.matchedText !== "label") throw Error(JSON.stringify(strict));
const name = await tools.select({ path: strict, operation: { kind: "sliceText", from: 0 } });
if (name.status !== "success" || name.data.items[0]?.preview !== "label") throw Error(JSON.stringify(name));
if (${JSON.stringify(mode)} === "scope") {
const local = await tools.read({ path: ${JSON.stringify(local)} });
const overlap = await tools.select({ path: strict, operation: { kind: "intersection", scopes: local } });
if (overlap.status !== "success" || overlap.data.totalItems !== 0) throw Error(JSON.stringify(overlap));
const navigation = await tools.search({ query: "symbols:label", path: seed, navigation: "references" });
if (navigation.status !== "success" || navigation.data.matches.length !== 2) throw Error(JSON.stringify(navigation));
if (navigation.data.matches[1]?.source !== ${JSON.stringify(`${root}/reference.ts`)} || navigation.data.matches[1]?.role !== "reference") throw Error(JSON.stringify(navigation));
if (new Set(navigation.data.matches.map(m => m.symbol.id)).size !== 1) throw Error("Lost originating declaration identity");
const cut = await tools.select({ path: seed, operation: { kind: "sliceText", from: 1 } });
const absent = await tools.search({ query: "symbols:label", path: cut });
if (absent.status !== "success" || absent.data.matches.length !== 0) throw Error("Partial name must not widen: " + JSON.stringify(absent));
text({ strict: strict.data, name: name.data, navigation: navigation.data, absent: absent.data });
} else {
const changed = await tools.replace({ path: name, text: "renamed" });
if (changed.status !== "success" || changed.data.effect === "not-applied") throw Error(JSON.stringify(changed));
text(changed);
const stale = await tools.search({ query: "symbols:label", path: seed });
if (stale.status !== "error") throw Error("Changed symbol snapshots must be stale: " + JSON.stringify(stale));
text({ stale });
}

`,
              },
            }),
          ]),
          assistantMessage([text("Native declaration identity and source bounds stayed intact.")]),
        ],
      }).run("Use the existing Select and Search tools on only the configured SSH source.");
      expect(getToolExecution(run, "ordinary").isError, getToolResultText(run, "ordinary")).toBe(
        false,
      );
      expect(getToolResultText(run, "ordinary")).not.toContain(`${root}/reference.ts`);
      expect(getToolExecution(run, "scoped").isError, getToolResultText(run, "scoped")).toBe(false);
      if (mode === "scope")
        expect(getToolResultText(run, "scoped")).toContain('"role":"reference"');
      else expect(getToolResultText(run, "scoped")).toContain("stale");
      expect((await backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
        mode === "mutation" ? source.replace("label", "renamed") : source,
      );
      expect((await backend.read(`${fixture.workspace}/reference.ts`)).bytes.toString("utf8")).toBe(
        source,
      );
      expect(await readFile(local, "utf8")).toBe(source);
      expect(run.tuiRenderedOutput).toContain(`${root}/note.ts`);
    } finally {
      await fixture.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120000,
);
