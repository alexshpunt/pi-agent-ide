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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

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
    rawMode: true,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "ast_search", "lsp_search", "replace", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `ast-${index}`,
              name: "codemode",
              arguments: { code: textResultChecks + code },
            }),
          ],
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
      `const window=await tools.read({path:"calls.ts",offset:2,limit:1});
const found=await tools.ast_search({path:window,pattern:"legacyRequest($OPTIONS)"});
check(found.matches.length===1 && found.matches[0].path==="calls.ts" && found.matches[0].line===2 && found.matches[0].text==="legacyRequest({ timeout: 20 })","AST escaped Read or lost UTF16 coordinates");
const options=found.matches[0].captures.OPTIONS;
check(options.length===1 && options[0].text==="{ timeout: 20 }","Capture lost association");
const timeout=await tools.search({path:options,query:"20"});
check(timeout.matches.length===1,"Capture cannot be searched");
text(await tools.replace({path:timeout,text:"99"}));`,
    ]);
    expectScriptsPassed(run, 1);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(source.replace("20", "99"));
    expect(run.tuiRenderedOutput).toContain("legacyRequest");
    expect(run.tuiRenderedOutput).toContain("99");
  });
});

test("searches the current text of a Read window whose lines other sessions changed", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "calls.ts"),
      "legacyRequest(a);\nlegacyRequest(b);\nother();\nlegacyRequest(c);\nlegacyRequest(d);\n",
    );
    const run = await runAstComposition(cwd, "ast-changed-window", [
      `const window=await tools.read({path:"calls.ts",offset:2,limit:3});
await tools.replace({path:"calls.ts",start:"other();",text:"changed();"});
await tools.replace({path:"calls.ts",start:"legacyRequest(a);",text:"legacyRequest(top);\\nlegacyRequest(a);"});
const found=await tools.ast_search({path:window,pattern:"legacyRequest($ARG)"});
check(found.matches.map(match=>match.line+":"+match.text).join()==="3:legacyRequest(b),5:legacyRequest(c)","Wrong matches for the current region");
const stale=await tools.search({path:window,query:"changed"});
check(stale.matches.length===1 && stale.matches[0].line===4,"Search lost the changed region");
await rejects(()=>tools.replace({path:window,text:"BAD"}));
text(await tools.replace({path:found.matches[1],text:"legacyRequest(z)"}));`,
    ]);
    expectScriptsPassed(run, 1);
    expect(codemodeFailures(getToolResultText(run, "ast-0"))).toMatch(
      /^1 of \d+ IDE calls failed:\n- replace RESULT#[a-f\d-]{36}\n[\s\S]*expired/u,
    );
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(
      "legacyRequest(top);\nlegacyRequest(a);\nlegacyRequest(b);\nchanged();\nlegacyRequest(z);\nlegacyRequest(d);\n",
    );
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
check(seed.matches.length===3,"Fixture scopes missing");
const found=await tools.ast_search({path:seed,pattern:"legacyRequest($$$ARGS)"});
check(found.matches.length===3,"Sparse AST scope widened");
const groups=found.matches.map(match=>match.captures.ARGS);
check(groups.length===3 && groups.every(group=>group.length===3),"Multi-capture association lost");
check(groups.map(group=>group.map(node=>node.text).join("")).join()==="a,b,c,d,e,f","Capture nodes changed");
for(const group of groups) check((await tools.search({path:group,query:"ignored"})).matches.length===0,"Capture escaped");
const partial=await tools.ast_search({path:seed,pattern:"legacyRequest($$$ARGS)",limit:1});
check(partial.matches.length===1 && partial.complete===false,"Limited Search must report one match and incomplete coverage");
await rejects(()=>tools.replace({path:partial,text:"BAD"}));
text({groups:3,complete:true});`,
    ]);
    expectScriptsPassed(run, 1);
    expect(codemodeFailures(getToolResultText(run, "ast-0"))).toMatch(
      /^1 of \d+ IDE calls failed:\n- replace RESULT#[a-f\d-]{36}\n[\s\S]*[Ii]ncomplete/u,
    );
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
const strict=await tools.lsp_search({path:window,query:"ping"}).then(value => value.result);
check(matches(strict).length===1 && strict.includes("service.ts:1:17 definition ping"),"LSP escaped Read or lost exact coordinates");
const nav=await tools.lsp_search({path:window,query:"ping",references:true}).then(value => value.result);
text(nav);
check(!nav.includes("other.ts"),"LSP mixed same-name declarations");
const rows=nav.split(String.fromCharCode(10)).filter(row=>/SEARCH#.*:match .*reference ping/.test(row));
check(rows.length>0 && rows.every(row=>row.includes("declared at service.ts:1:17")),"Reference association missing");
check(nav.includes("consumer.ts:2:7 reference ping"),"Reference UTF16 mapping lost");
const external=rows.find(row=>row.includes("consumer.ts:3:1"));
check(external,"External reference missing");
const selected=await tools.read({path:matches(external)[0]});
const textHit=await tools.search({path:selected,query:"ping"});
check(textHit.matches.length===1 && textHit.matches[0].path==="consumer.ts" && textHit.matches[0].line===3,"LSP target cannot be searched");
text(await tools.replace({path:textHit,text:"PING"}));`,
      ],
      true,
    );
    expectScriptsPassed(run, 1);
    expect(await readFile(path.join(cwd, "consumer.ts"), "utf8")).toBe(
      consumer.replace('ping("outside")', 'PING("outside")'),
    );
    expect(getToolResultText(run, "ast-0")).toContain("LSP reference navigation");
    expect(getToolResultText(run, "ast-0")).toContain("reference ping");
  });
}, 120_000);
test("retains every node of a capture larger than the ordinary match preview", async () => {
  await withTempWorkspace(async (cwd) => {
    const arguments_ = Array.from({ length: 120 }, (_, index) => `arg${String(index)}`);
    await writeFile(path.join(cwd, "large.ts"), `legacyRequest(${arguments_.join(", ")});\n`);
    const run = await runAstComposition(cwd, "ast-large-capture", [
      `const found=await tools.ast_search({path:"large.ts",pattern:"legacyRequest($$$ARGS)"});
const args=found.matches[0].captures.ARGS;
check(found.matches.length===1 && args.length===239 && args[238].text==="arg119","Capture group silently shortened");
const last=await tools.search({path:args,query:"arg119"});
check(last.matches.length===1,"Last captured node lost authority");
check((await tools.search({path:args[238],query:"arg119"})).matches.length===1,"Last node id lost authority");
text({nodes:239,last:"arg119"});`,
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
for(const input of [window,window.id.slice("RESULT#".length),window.id]) {
 const found=await tools.ast_search({path:input,pattern:"legacyRequest($OPTIONS)"});
 check(found.matches.length===1 && found.matches[0].line===2,"Read input forms differ");
 store("ast-capture",found.matches[0].captures.OPTIONS);
}
text({saved:true});`,
      `const old=load("ast-capture");
const changed=await tools.replace({path:old,text:"{ timeout: 99 }"});
const found=await tools.ast_search({path:changed,pattern:"{ timeout: $VALUE }"});
check(found.matches.length===1,"AST cannot consume mutation");
const values=await tools.search({path:found.matches[0].captures.VALUE,query:"99"});
check(values.matches.length===1,"Capture VALUE lost authority");
await rejects(()=>tools.replace({path:old,text:"BAD"}));
text({pendingAst:1,staleRejected:true});`,
    ]);
    expectScriptsPassed(run, 2);
    expect(codemodeFailures(getToolResultText(run, "ast-1"))).toMatch(
      /^1 of \d+ IDE calls failed:\n- replace [\s\S]*(?:expired|stale)/u,
    );
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(source.replace("20", "99"));
  });
});
test("never widens an empty AST scope or a range cutting through an AST node", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "calls.ts"), "legacyRequest({ timeout: 10 });\n");
    const run = await runAstComposition(cwd, "ast-boundary-empty-scope", [
      `const seed=await tools.search({path:"calls.ts",query:"timeout"});
const cut=await tools.ast_search({path:seed,pattern:"legacyRequest($OPTIONS)"});
const empty=await tools.ast_search({path:[],pattern:"legacyRequest($OPTIONS)"});
for(const found of [cut,empty]) check(found.matches.length===0 && found.complete===true,"AST scope widened");
text({cut:0,empty:0});`,
    ]);
    expectScriptsPassed(run, 1);
  });
});
