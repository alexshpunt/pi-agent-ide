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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { nestedResultTexts } from "#integration/support/nested-results.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { SshBackend } from "#src/backend/ssh.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each(["scope", "mutation"] as const)(
  "native SSH symbol targets keep exact %s authority",
  async (mode) => {
    // Every tool call makes several remote operations; reuse one SSH connection for them.
    const fixture = await startSshFixture(
      {},
      { PI_CODING_AGENT_DIR: "{workspace}/agent-home" },
      undefined,
      { multiplex: true },
    );
    const base = path.resolve(".tmp/ssh-lsp-scope-tests");
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
            "ide.diagnostics",
          ],
        }),
      );
      const run = await new PiIntegrationTest({
        testName: `ssh-lsp-scope-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "search", "lsp_search", "replace", "codemode"],
        // Pi starts here and every tool call reaches the fixture server through SSH. Measured at
        // load average 37 with another integration suite running: 95-100 s for the whole case,
        // so a step may take over 90 s. The cap stops a hung run, like the 150 s of ssh-lsp-tools.
        timeoutMs: 150_000,
        conversation: [
          assistantMessage([
            toolCall({
              id: "ordinary",
              name: "lsp_search",
              arguments: { query: "label", path: `${root}/note.ts` },
            }),
          ]),
          assistantMessage([
            toolCall({
              id: "scoped",
              name: "codemode",
              arguments: {
                code: `
const read = await tools.read({ path: ${JSON.stringify(`${root}/note.ts`)} });
const seed = await tools.search({ path: read, query: "label", caseSensitive: true, wholeWord: true });
if(seed.matches.length!==1) throw Error("Seed search: "+JSON.stringify(seed));

const strict=await tools.lsp_search({query:"label",path:seed});
// Inside the seed the name is only its definition.
if(strict.matches.length!==1 || strict.matches[0].text!=="label") throw Error(JSON.stringify(strict));
const name=strict;
if(${JSON.stringify(mode)} === "scope") {
 const navigation=await tools.lsp_search({query:"label",path:seed,references:true});
 // The definition and its reference in another file; the readable result shows that both name
 // one declaration.
 if(navigation.matches.length!==2 || !navigation.matches.some(match=>match.path===${JSON.stringify(`${root}/reference.ts`)} && match.text==="label")) throw Error(JSON.stringify(navigation));
 const cut=await tools.search({path:seed,query:"abel",caseSensitive:true});
 if(cut.matches.length!==1 || cut.matches[0].text!=="abel") throw Error("Partial search: "+JSON.stringify(cut));
 const absent=await tools.lsp_search({query:"label",path:cut});
 if(absent.matches.length!==0) throw Error("Partial name widened: "+JSON.stringify(absent));
 text({strict,name,navigation,absent});
} else {
 text(await tools.replace({path:name,text:"renamed"}));
 // A refused call resolves to null; the Codemode result lists its reason.
 const stale = await tools.lsp_search({query:"label",path:seed});
 if(stale !== null) throw Error("Changed snapshot was accepted: "+JSON.stringify(stale));
 text({staleRefused:true});
}

`,
              },
            }),
          ]),
          assistantMessage([text("Native declaration identity and source bounds stayed intact.")]),
        ],
      }).run("Use the existing Read and Search tools on only the configured SSH source.");
      expect(getToolExecution(run, "ordinary").isError, getToolResultText(run, "ordinary")).toBe(
        false,
      );
      expect(getToolResultText(run, "ordinary")).not.toContain(`${root}/reference.ts`);
      expect(getToolExecution(run, "scoped").isError, getToolResultText(run, "scoped")).toBe(false);
      if (mode === "scope") {
        // One declaration behind both hits: the definition names it by its own selector, the
        // reference by the position where it is declared, which is the definition's own position.
        const navigation =
          nestedResultTexts(run, "lsp_search").find((shown) => shown.includes("reference label")) ??
          "";
        const definition = /(\S+:\d+:\d+) definition label · selector (\S+)#label/u.exec(
          navigation,
        );
        const references = [
          ...navigation.matchAll(/(\S+:\d+:\d+) reference label · declared at (\S+)/gu),
        ];
        expect(definition, navigation).not.toBeNull();
        expect(references, navigation).toHaveLength(1);
        const [, position = "", file = ""] = definition ?? [];
        expect(position.startsWith(`${file}:`), navigation).toBe(true);
        expect(references[0]?.[2], navigation).toBe(position);
      } else
        expect(codemodeFailures(getToolResultText(run, "scoped"))).toMatch(
          /^1 of \d+ IDE calls failed:\n- lsp_search \S+\n[\s\S]*(?:stale|changed|expired)/u,
        );
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
  240_000,
);
