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

test("Select derives remote text and AST targets without confusing an identical local snapshot", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-select-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const source =
    'function greet(value: string) { return value + " café"; }\r\ngreet("hello", "world");\r\n';
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const remote = `ssh://fixture${fixture.workspace}/note.ts`;
  const local = path.join(cwd, "note.ts");
  try {
    await backend.write(`${fixture.workspace}/note.ts`, Buffer.from(source), null);
    await writeFile(local, source);
    await backend.write(`${fixture.workspace}/emoji.txt`, Buffer.from("a😀b\r\n"), null);
    await backend.write(
      `${fixture.workspace}/secret.ts`,
      Buffer.from("PRIVATE_OWNED_READ_CONTENT\n"),
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
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
          "ide.lint",
          "ide.formatter",
          "ide.diagnostics",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-select",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/ssh-user-hooks-extension.ts"),
        "builtin:codemode",
      ],
      tools: ["read", "search", "select", "replace", "codemode"],
      timeoutMs: 120000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "denied",
            name: "select",
            arguments: {
              path: `ssh://fixture${fixture.workspace}/secret.ts`,
              operation: { kind: "position", edge: "after" },
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "ordinary",
            name: "select",
            arguments: { path: remote, operation: { kind: "lines", first: 1, last: 1 } },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "native",
            name: "codemode",
            arguments: {
              code: `
async function expectFailure(action, label) {
  let failure;
  try { await action(); } catch(error) { failure = String(error); }
  if (!failure) throw Error(label + " unexpectedly succeeded");
  text({label,failure});
}
await expectFailure(() => tools.select({path:${JSON.stringify(`ssh://fixture${fixture.workspace}/secret.ts`)},operation:{kind:"position",edge:"after"}}), "guarded");
const emoji = await tools.read({path:${JSON.stringify(`ssh://fixture${fixture.workspace}/emoji.txt`)}});
for (const to of [2,5]) await expectFailure(() => tools.select({path:emoji,operation:{kind:"sliceText",from:0,to}}), "split boundary");
const valid = await tools.select({path:emoji,operation:{kind:"sliceText",from:1,to:3}});
if (!valid.includes("😀")) throw Error(valid);
const bytes = await tools.read({path:${JSON.stringify(`raw:ssh://fixture${fixture.workspace}/emoji.txt`)}});
await expectFailure(() => tools.select({path:bytes,operation:{kind:"position",edge:"after"}}), "raw authority");
const read = await tools.read({path:${JSON.stringify(remote)}});
const line = await tools.select({path:read,operation:{kind:"lines",first:1,last:1}});
const trimmed = await tools.select({path:line,operation:{kind:"trim",side:"both"}});
const fn = await tools.select({path:trimmed,operation:{kind:"object",object:"function"}});
const body = await tools.select({path:fn,operation:{kind:"part",part:"body"}});
const calls = await tools.select({path:read,operation:{kind:"navigate",relation:"descendants",object:"call"}});
const args = await tools.select({path:calls,operation:{kind:"part",part:"arguments"}});
const value = await tools.select({path:args,operation:{kind:"sliceText",from:1,to:8}});
const extent = await tools.select({path:value,operation:{kind:"elementExtent",extent:"around"}});
const local = await tools.read({path:${JSON.stringify(local)}});
const overlap = await tools.select({path:line,operation:{kind:"intersection",scopes:local}});
text({fn,body,extent,overlap});
const contextual = await tools.read({path:extent});
const retained = await tools.select({path:contextual,operation:{kind:"sliceText",from:0}});
if (!retained.includes("hello")) throw Error(retained);
const outside = await tools.search({path:extent,query:"world"});
if (!outside.includes("No matches found")) throw Error("Scoped search widened: " + outside);
const inside = await tools.search({path:extent,query:"hello"});
const selected = await tools.select({path:inside,operation:{kind:"sliceText",from:0}});
if (!selected.includes("hello")) throw Error(selected);
text({retained,selected});
const ast = await tools.search({path:line,query:"ast:function $NAME($$$ARGS) { $$$BODY }"});
const capture = /capture NAME: (\\S+)/.exec(ast)?.[1];
if (!capture) throw Error("Missing owned AST capture: " + ast);
const name = await tools.select({path:capture,operation:{kind:"sliceText",from:0}});
if (!name.includes("greet")) throw Error(name);
const absentCall = await tools.search({path:line,query:"ast:greet($$$ARGS)"});
if (!absentCall.includes("No AST matches found")) throw Error("AST scope widened: " + absentCall);
text({ast,name});
text(await tools.replace({path:extent,text:""}));
await expectFailure(() => tools.select({path:read,operation:{kind:"position",edge:"after"}}), "stale");

`,
            },
          }),
        ]),
        assistantMessage([text("Selected canonical remote text and kept the local file.")]),
      ],
    }).run(
      "Derive exact source boundaries on the configured SSH source with the existing Select tool.",
    );
    expect(getToolExecution(run, "denied").isError).toBe(true);
    expect(getToolResultText(run, "denied")).not.toContain("PRIVATE_OWNED_READ_CONTENT");
    expect(getToolExecution(run, "ordinary").isError, getToolResultText(run, "ordinary")).toBe(
      false,
    );
    expect(getToolResultText(run, "ordinary")).toContain(remote);
    expect(getToolExecution(run, "native").isError, getToolResultText(run, "native")).toBe(false);
    const result = getToolResultText(run, "native");
    expect(result).toContain("greet");
    expect(result).toContain("hello");
    expect(result).toContain("capture NAME:");
    expect(result).toContain("No AST matches found");
    expect(result).toContain("stale");
    expect((await backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
      source.replace('"hello", ', ""),
    );
    expect(await readFile(local, "utf8")).toBe(source);
    expect(run.tuiRenderedOutput).toContain("select");
    expect(run.tuiRenderedOutput).toContain("ssh://fixture");
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 150000);
