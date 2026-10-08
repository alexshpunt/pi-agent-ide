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
import { textResultChecks } from "#integration/support/text-result-checks.js";

async function runSelection(
  cwd: string,
  name: string,
  scripts: readonly string[],
  extraExtensions: readonly string[] = [],
  postProcessing = false,
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({
      disabled: ["ide.lsp", "ide.lint"],
      noPostProcessing: !postProcessing,
    }),
  );
  const run = await new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: name !== "select-full-preview-targets",
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode", ...extraExtensions],
    tools: ["read", "search", "select", "replace", "write", "undo", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `select-${index}`,
              name: "codemode",
              arguments: { code: textResultChecks + code },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Selection composition finished.")]),
    ],
  }).run("Select exact enclosing functions and their bodies through native tools");
  for (let index = 0; index < scripts.length; index++)
    expect(
      getToolExecution(run, `select-${index}`).isError,
      getToolResultText(run, `select-${index}`),
    ).toBe(false);
  return run;
}

test("keeps sparse files, strict completeness, valid absence and structural refusals", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "a.ts"),
      "function a() { first(); second(); } function ignored() { outside(); }",
    );
    await writeFile(path.join(cwd, "b.js"), "function b() { third(); }");
    await writeFile(path.join(cwd, "other.py"), "probe()");
    await runSelection(cwd, "select-sparse-refusals", [
      `const a=await tools.search({path:"a.ts",query:"regex:first[(][)]|second[(][)]"});
const b=await tools.search({path:"b.js",query:"third()"});
const owners=await tools.select({path:[a,b],operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(items(owners).length===2,"Sparse associations lost");
check(matches(await tools.search({path:owners,query:"outside()"})).length===0,"Sparse gap widened");
const partial=await tools.search({path:"a.ts",query:"ast:$NAME()",limit:1});
const incomplete=await tools.select({path:partial,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(incomplete.includes("incomplete input"),"Completeness discarded");
const partialRead=await tools.read({path:incomplete});
const stillPartial=await tools.select({path:partialRead,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(stillPartial.includes("incomplete input"),"Read laundered completeness");
await rejects(()=>tools.replace({path:incomplete,text:"BAD"}),/[Ii]ncomplete/);
const empty=await tools.select({path:[],operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(items(empty).length===0 && !empty.includes("incomplete"),"Empty target set rejected");
const missing=await tools.search({path:"a.ts",query:"notFound"});
check(items(await tools.select({path:missing,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}})).length===0,"Empty Search not supported");
for(const [path,operation] of [
 ["a.ts",{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}],
 [a,{kind:"part",part:"body"}],
 ["other.py",{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}],
 ["RESULT#forged",{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}],
 [{source:"a.ts",range:{startLine:1,startColumn:0,endLine:1,endColumn:1}},{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}]
]) await rejects(()=>tools.select({path,operation}));
text({files:2,owners:2,complete:false,refusals:5});`,
    ]);
    expect(await readFile(path.join(cwd, "a.ts"), "utf8")).toBe(
      "function a() { first(); second(); } function ignored() { outside(); }",
    );
  });
});

test("preview limits do not clip the full selection target", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = Array.from(
      { length: 105 },
      (_, index) => `function f${index}() { probe(); }`,
    ).join("\r\n");
    const big = `function large() { ${"consume(); ".repeat(300)} tail(); }`;
    const medium = `function medium() { ${"consume(); ".repeat(20)} }`;
    await writeFile(path.join(cwd, "many.ts"), source);
    await writeFile(path.join(cwd, "big.ts"), big);
    await writeFile(path.join(cwd, "medium.ts"), medium);
    const run = await runSelection(
      cwd,
      "select-full-preview-targets",
      [
        `const seed=await tools.search({path:"many.ts",query:"probe()",limit:200});
const owners=await tools.select({path:seed,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(owners.includes("105 selection(s)") && items(owners).length===100 && !owners.includes("incomplete"),"Preview completeness confused");
const every=await tools.search({path:owners,query:"probe()",limit:200});
check(matches(every).length===105,"Search lost selected matches beyond the Select preview");
const beyond=await tools.search({path:owners,query:"ast:function f104() { $$$BODY }"});
check(matches(beyond).length===1,"Whole result clipped to preview");
const direct=await tools.select({path:"big.ts",operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(direct.includes("preview shortened"),"Unbounded preview");
check(matches(await tools.search({path:direct,query:"tail()"})).length===1,"Text preview clipped authority");
const compact=await tools.select({path:"medium.ts",operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(!compact.includes("preview shortened") && compact.includes("consume();"),"Medium preview fixture invalid");
text({total:105,preview:100,tail:1});`,
      ],
      [path.resolve("tests/integration/support/compact-tool-presentation.ts")],
    );
    expect(await readFile(path.join(cwd, "many.ts"), "utf8")).toBe(source);
    expect(await readFile(path.join(cwd, "big.ts"), "utf8")).toBe(big);
    const compactPanel = run.tuiRenderedOutput.slice(
      run.tuiRenderedOutput.lastIndexOf("select enclosing function"),
    );
    expect(compactPanel).toContain("medium.ts");
    expect(compactPanel).toContain("╭─ 1 selection in 1 file");
    expect(compactPanel).toMatch(/1\s+│\s+function medium/u);
    expect(compactPanel).not.toContain("origin(s)");
    expect(compactPanel).not.toContain('"function medium');
  });
});

test("keeps selections unformatted within one script and rejects them after final processing", async () => {
  await withTempWorkspace(async (cwd) => {
    const initial = "function task() {\r\n  format_me();\r\n}\r\n";
    await writeFile(path.join(cwd, "select-format.ts"), initial);
    const run = await runSelection(
      cwd,
      "select-final-formatting",
      [
        `const seed=await tools.search({path:"select-format.ts",query:"format_me()"});
const owner=await tools.select({path:seed,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
const selectedBody=await tools.select({path:owner,operation:{kind:"part",part:"body"}});
const found=await tools.search({path:selectedBody,query:"format_me()"});
const changed=await tools.replace({path:found,text:"final_format_me()"});
const current=await tools.select({path:changed,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(current.includes("final_format_me()"),"Selection ran formatting early");
store("pre-format-selection",current);
text({unformattedInsideScript:true});`,
        `await rejects(()=>tools.select({path:load("pre-format-selection"),operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}}),/expired|stale/);
await rejects(()=>tools.replace({path:load("pre-format-selection"),text:"BAD"}),/expired|stale/);
check(matches(await tools.search({path:"select-format.ts",query:"final_FORMATTED()"})).length===1,"Final processing missing");
text({staleRejected:true});`,
      ],
      [path.resolve("tests/integration/support/native-post-edit-probe.ts")],
      true,
    );
    expect(await readFile(path.join(cwd, "select-format.ts"), "utf8")).toBe(
      initial.replace("format_me()", "final_FORMATTED()"),
    );
    const events = (await readFile(path.join(cwd, "post-edit-events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(events).toHaveLength(1);
    expect(run.tuiRenderedOutput).toContain("final_FORMATTED");
  });
});
test("consumes pending writes, retains cross-call handles and rejects stale and whole-file widening", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "pending.ts"), "protected before\r\nprotected after");
    await runSelection(cwd, "select-pending-stale-guards", [
      `const changed=await tools.write({path:"pending.ts",content:"function pending() { probe(); }"});
const owner=await tools.select({path:changed,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(items(owner).length===1,"Pending Select did not confirm source");
const selectedBody=await tools.select({path:items(owner)[0].ref,operation:{kind:"part",part:"body"}});
store("selection-body",selectedBody);
text({pendingConsumed:true});`,
      `const target=load("selection-body");
check(items(await tools.select({path:target,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}})).length===1,"Cross-call target expired early");
await rejects(()=>tools.write({path:target,content:"BAD"}));
await rejects(()=>tools.undo({file:target,change:"last"}));
const found=await tools.search({path:target,query:"probe()"});
await tools.replace({path:found,text:"done()"});
await rejects(()=>tools.select({path:target,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}}),/expired|stale/);
await rejects(()=>tools.replace({path:target,text:"BAD"}),/expired|stale/);
text({crossCall:true,staleRejected:true,wholeFileGuards:2});`,
    ]);
    expect(await readFile(path.join(cwd, "pending.ts"), "utf8")).toBe(
      "function pending() { done(); }",
    );
  });
});

test("expands a narrow Read window, composes every selection input form and keeps exact edits", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = '"😀"; function a() {\r\n probe();\r\n} function b() { other(); }';
    await writeFile(path.join(cwd, "window.ts"), source);
    await writeFile(path.join(cwd, "direct.js"), "function direct() {}");
    const run = await runSelection(cwd, "select-window-forms", [
      `const window=await tools.read({path:"window.ts",offset:2,limit:1});
const owner=await tools.select({path:window,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
const item=items(owner)[0];
check(items(owner).length===1 && item.startColumn===6 && item.endLine===3 && item.endColumn===1,"Wrong expansion coordinates");
for(const path of [owner,uuid(owner),"RESULT#"+uuid(owner),item.ref,[item.ref,item.ref]]) {
 const same=await tools.select({path,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
 check(items(same).length===1 && items(same)[0].location===item.location,"Selection input lost geometry");
}
check(items(await tools.select({path:"direct.js",operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}})).length===1,"Whole-file function unsupported");
const selectedBody=await tools.select({path:item.ref,operation:{kind:"part",part:"body"}});
check(selectedBody.endsWith(["{"," probe();","}"].join(String.fromCharCode(13,10))),"Body lost CRLF");
const preview=await tools.read({path:selectedBody});
for(const query of ["😀","other()"]) check(matches(await tools.search({path:preview,query})).length===0,"Read context widened authority");
check(matches(await tools.search({path:preview,query:"}"})).length===1,"Read omitted closing line");
const found=await tools.search({path:selectedBody,query:"probe()"});
check(matches(found).length===1,"Body Search unavailable");
text(await tools.replace({path:found,text:"done()"}));
text({expanded:true});`,
    ]);
    expect(await readFile(path.join(cwd, "window.ts"), "utf8")).toBe(
      source.replace("probe()", "done()"),
    );
    expect(run.tuiRenderedOutput).toContain("done()");
  });
});

test("selects enclosing functions and bodies without losing callback calls or editing other options", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = [
      'function yes() { "😀"; legacyRequest({ timeout: 10 }); legacyRequest({ timeout: 11 }); retry(() => { ignored(); }); const unrelated = { timeout: 90 }; }',
      "function nested() { legacyRequest({ timeout: 20 }); function child(value = retry()) {} }",
      'function no() { legacyRequest({ timeout: 30 }); /* retry() */ const text = "retry()"; }',
      "function nestedOptions() { legacyRequest({ timeout: 40, extra: { timeout: 41 } }); retry(); }",
    ].join("\r\n");
    await writeFile(path.join(cwd, "calls.ts"), source);
    const run = await runSelection(cwd, "select-function-body-timeouts", [
      `const calls=await tools.search({path:"calls.ts",query:"ast:legacyRequest($OPTIONS)"});
check(matches(calls).length===5,"Missing calls");
const owners=await tools.select({path:calls,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
check(items(owners).length===4,"Owner dedup lost association");
const accepted=[];
for(const owner of items(owners)){
 const selectedBody=await tools.select({path:owner.ref,operation:{kind:"part",part:"body"}});
 const retry=await tools.search({path:selectedBody,query:"ast:retry($$$ARGS)"});
 const retryOwners=await tools.select({path:retry,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
 if(items(retryOwners).some(item=>item.location===owner.location)) accepted.push(owner.ref);
}
check(accepted.length===2,"Nested retry counted or callback retry dropped");
const values=[];
for(const owner of accepted){
 const eligible=await tools.search({path:owner,query:"ast:legacyRequest($OPTIONS)"});
 for(const ref of matches(eligible)){
  const patterns=["legacyRequest({ timeout: $VALUE })","legacyRequest({ $$$BEFORE, timeout: $VALUE })","legacyRequest({ timeout: $VALUE, $$$AFTER })","legacyRequest({ $$$BEFORE, timeout: $VALUE, $$$AFTER })"];
  const call=await tools.read({path:ref});
  for(const pattern of patterns) values.push(...capture(await tools.search({path:call,query:"ast:"+pattern}),"VALUE"));
 }
}
const unique=await tools.select({path:values,operation:{kind:"merge"}});
check(items(unique).length===3,"Unrelated options included");
await tools.read({path:items(unique)[0].ref});
text(await tools.replace({path:unique,text:"99"}));
text({owners:4,eligible:2,timeouts:3});`,
    ]);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(
      source
        .replace("timeout: 10", "timeout: 99")
        .replace("timeout: 11", "timeout: 99")
        .replace("timeout: 40", "timeout: 99"),
    );
    expect(run.tuiRenderedOutput).toContain("99");
  });
});
