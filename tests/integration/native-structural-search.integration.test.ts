import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

async function runAstComposition(
  cwd: string,
  name: string,
  scripts: readonly string[],
  lsp = false,
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({
      disabled: lsp ? ["ide.lint"] : ["ide.lsp", "ide.lint"],
      noPostProcessing: true,
    }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "replace", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `ast-${index}`, name: "codemode", arguments: { code } })],
          {
            stopReason: "toolUse",
          },
        ),
      ),
      assistantMessage([text("AST composition finished.")]),
    ],
  }).run("Compose AST Search and captures through source-aware results without Select");
}

function expectScriptsPassed(run: Awaited<ReturnType<typeof runAstComposition>>, count: number) {
  for (let index = 0; index < count; index++)
    expect(
      getToolExecution(run, `ast-${index}`).isError,
      getToolResultText(run, `ast-${index}`),
    ).toBe(false);
}

test("searches AST inside a Read window and edits a named capture with exact CRLF coordinates", async () => {
  await withTempWorkspace(async (cwd) => {
    const source =
      'legacyRequest({ timeout: 10 });\r\n"😀"; legacyRequest({ timeout: 20 });\r\nlegacyRequest({ timeout: 30 });';
    await writeFile(path.join(cwd, "calls.ts"), source);
    const run = await runAstComposition(cwd, "ast-window-capture-edit", [
      `const window = await tools.read({path:"calls.ts",offset:2,limit:1});
const found = await tools.search({path:window,query:"ast:legacyRequest($OPTIONS)"});
if(found.status!=="success") throw Error(JSON.stringify(found.errors));
if(found.data.matches.length!==1 || found.data.matches[0].range.startColumn!==6) throw Error("AST escaped Read or lost UTF-16 coordinates");
const options=found.data.matches[0].captures.OPTIONS;
if(options.length!==1 || options[0].matchedText!=="{ timeout: 20 }") throw Error("Capture lost its parent or source");
const timeout=await tools.search({path:options,query:"20"});
if(timeout.status!=="success" || timeout.data.matches.length!==1) throw Error("Capture cannot be searched");
const changed=await tools.replace({path:timeout,text:"99"});
if(changed.status!=="success") throw Error(JSON.stringify(changed.errors));
text({matches:found.data.matches.length,capture:options[0].matchedText});`,
    ]);
    expectScriptsPassed(run, 1);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(source.replace("20", "99"));
    expect(run.tuiRenderedOutput).toContain("legacyRequest");
    expect(run.tuiRenderedOutput).toContain("99");
  });
});

test("keeps sparse multi-file AST scopes and capture groups without matching across a gap", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "a.ts"),
      "legacyRequest(a, b);\nlegacyRequest(ignored);\nlegacyRequest(c, d);\n",
    );
    await writeFile(path.join(cwd, "b.ts"), "legacyRequest(e, f);\n");
    const run = await runAstComposition(cwd, "ast-sparse-multi-captures", [
      `const seed=await tools.search({path:".",include:"*.ts",query:"regex:legacyRequest[(](a, b|c, d|e, f)[)]"});
if(seed.status!=="success" || seed.data.matches.length!==3) throw Error("Fixture scopes missing");
const found=await tools.search({path:seed.data.matches,query:"ast:legacyRequest($$$ARGS)"});
if(found.status!=="success") throw Error(JSON.stringify(found.errors));
if(found.data.matches.length!==3) throw Error("Sparse AST scope widened");
const groups=found.data.matches.map(m=>m.captures.ARGS.map(c=>c.matchedText));
if(JSON.stringify(groups)!==JSON.stringify([["a",",","b"],["c",",","d"],["e",",","f"]])) throw Error("Multi capture association lost: "+JSON.stringify(groups));
const inside=await tools.search({path:found.data.matches[0].captures.ARGS,query:"ignored"});
if(inside.status!=="success" || inside.data.matches.length!==0) throw Error("Capture escaped");
const partial=await tools.search({path:seed,query:"ast:legacyRequest($$$ARGS)",limit:1});
if(partial.status!=="success" || partial.data.complete!==false) throw Error("Limit reported complete");
const rejected=await tools.replace({path:partial,text:"BAD"});
if(rejected.status!=="error" || rejected.data.effect!=="not-applied") throw Error("Incomplete AST became an edit scope");
text({groups,complete:found.data.complete});`,
    ]);
    expectScriptsPassed(run, 1);
    expect(await readFile(path.join(cwd, "a.ts"), "utf8")).toContain("legacyRequest(ignored)");
  });
});

test("composes real LSP discovery and explicit external references without mixing same-name symbols", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          typescript: {
            command: ["typescript-language-server", "--stdio"],
            rootMarkers: ["tsconfig.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
        },
      }),
    );
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["*.ts"] }),
    );
    await writeFile(
      path.join(cwd, "service.ts"),
      "export function ping(value: string) { return value; }\r\n",
    );
    await writeFile(path.join(cwd, "other.ts"), 'export function ping() { return "unrelated"; }\n');
    const consumer =
      'import { ping } from "./service";\r\n"😀"; ping("inside");\r\nping("outside");';
    await writeFile(path.join(cwd, "consumer.ts"), consumer);
    const run = await runAstComposition(
      cwd,
      "lsp-scope-navigation-composition",
      [
        `const window=await tools.read({path:"service.ts",offset:1,limit:1});
const strict=await tools.search({path:window,query:"symbols:ping"});
if(strict.status!=="success") throw Error(JSON.stringify(strict.errors));
if(strict.data.matches.length!==1 || strict.data.matches[0].range.startLine!==1 || strict.data.matches[0].range.startColumn!==16) throw Error("LSP escaped Read or lost its exact range: "+JSON.stringify(strict.data.matches.map(m=>({range:m.range,text:m.matchedText,role:m.role}))));
const nav=await tools.search({path:window,query:"symbols:ping",navigation:"references"});
if(nav.status!=="success") throw Error(JSON.stringify(nav.errors));
if(nav.data.matches.some(m=>m.source.endsWith("/other.ts") || m.symbol.source.endsWith("/other.ts"))) throw Error("LSP mixed same-name symbols");
if(new Set(nav.data.matches.map(m=>m.symbol.id)).size!==1 || !nav.data.matches.every(m=>m.symbol.source.endsWith("/service.ts"))) throw Error("Reference association missing");
if(!nav.data.matches.some(m=>m.source.endsWith("/consumer.ts") && m.range.startLine===2 && m.range.startColumn===6)) throw Error("Reference UTF-16 mapping lost: "+JSON.stringify(nav.data.matches.map(m=>({source:m.source,range:m.range,symbol:m.symbol.id}))));
const external=nav.data.matches.filter(m=>m.source.endsWith("/consumer.ts") && m.range.startLine===3);
if(external.length!==1 || external[0].role!=="reference") throw Error("External reference missing");
const textHit=await tools.search({path:external,query:"ping"});
if(textHit.status!=="success" || textHit.data.matches.length!==1) throw Error("LSP target is not searchable");
const changed=await tools.replace({path:textHit,text:"PING"});
if(changed.status!=="success") throw Error(JSON.stringify(changed.errors));
text({strict:strict.data.matches.length,navigation:nav.data.matches.length,external:external[0].range});`,
      ],
      true,
    );
    expectScriptsPassed(run, 1);
    expect(await readFile(path.join(cwd, "consumer.ts"), "utf8")).toBe(
      consumer.replace('ping("outside")', 'PING("outside")'),
    );
    expect(run.tuiRenderedOutput).toContain("LSP reference navigation");
    expect(run.tuiRenderedOutput).toContain("reference ping");
  });
}, 120_000);
test("retains every node of a capture larger than the ordinary match preview", async () => {
  await withTempWorkspace(async (cwd) => {
    const arguments_ = Array.from({ length: 120 }, (_, index) => `arg${String(index)}`);
    await writeFile(path.join(cwd, "large.ts"), `legacyRequest(${arguments_.join(", ")});\n`);
    const run = await runAstComposition(cwd, "ast-large-capture", [
      `const found=await tools.search({path:"large.ts",query:"ast:legacyRequest($$$ARGS)"});
if(found.status!=="success") throw Error(JSON.stringify(found.errors));
const args=found.data.matches[0].captures.ARGS;
if(args.length!==239 || args.at(-1).matchedText!=="arg119" || !args.every(a=>typeof a.target==="string")) throw Error("Capture was silently shortened");
const last=await tools.search({path:args,query:"arg119"});
if(last.status!=="success" || last.data.matches.length!==1) throw Error("Last capture node lost source authority");
text({nodes:args.length,last:last.data.matches[0].matchedText});`,
    ]);
    expectScriptsPassed(run, 1);
  });
});

test("preserves AST input forms across calls and rejects captures after a dependent edit", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "legacyRequest({ timeout: 10 });\r\nlegacyRequest({ timeout: 20 });";
    await writeFile(path.join(cwd, "calls.ts"), source);
    const run = await runAstComposition(cwd, "ast-forms-cross-call-stale", [
      `const window=await tools.read({path:"calls.ts",offset:2,limit:1});
for(const input of [window,window.data,window.data.target]) {
 const found=await tools.search({path:input,query:"ast:legacyRequest($OPTIONS)"});
 if(found.status!=="success" || found.data.matches.length!==1) throw Error("Read input forms differ");
 store("ast-capture",found.data.matches[0].captures.OPTIONS);
}
text({saved:true});`,
      `const capture=load("ast-capture");
const changed=await tools.replace({path:capture,text:"{ timeout: 99 }"});
if(changed.status!=="success") throw Error(JSON.stringify(changed.errors));
const found=await tools.search({path:changed,query:"ast:{ timeout: $VALUE }"});
if(found.status!=="success" || found.data.matches.length!==1 || found.data.matches[0].captures.VALUE[0].matchedText!=="99") throw Error("AST cannot consume a pending mutation");
const stale=await tools.replace({path:capture,text:"BAD"});
if(stale.status!=="error" || stale.data.effect!=="not-applied" || !stale.errors.some(e=>e.message.includes("stale"))) throw Error("Changed AST capture gained authority");
text({pendingAst:found.data.matches.length,stale:stale.status});`,
    ]);
    expectScriptsPassed(run, 2);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(source.replace("20", "99"));
  });
});
test("never widens an empty AST scope or a range cutting through an AST node", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "calls.ts"), "legacyRequest({ timeout: 10 });\n");
    const run = await runAstComposition(cwd, "ast-boundary-empty-scope", [
      `const seed=await tools.search({path:"calls.ts",query:"timeout"});
const cut=await tools.search({path:seed,query:"ast:legacyRequest($OPTIONS)"});
const empty=await tools.search({path:[],query:"ast:legacyRequest($OPTIONS)"});
for(const found of [cut,empty]) if(found.status!=="success" || !found.data.complete || found.data.matches.length!==0) throw Error("AST scope widened");
text({cut:cut.data.matches.length,empty:empty.data.matches.length});`,
    ]);
    expectScriptsPassed(run, 1);
  });
});
