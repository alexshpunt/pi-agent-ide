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
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode", ...extraExtensions],
    tools: ["read", "search", "select", "replace", "write", "undo", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `select-${index}`, name: "codemode", arguments: { code } })],
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

const enclosing = '{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}';

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
const owners=await tools.select({path:[...a.data.matches,...b.data.matches],operation:${enclosing}});
if(owners.status!=="success" || owners.data.totalItems!==2 || owners.data.items[0].origins.length!==2) throw Error("Sparse associations lost");
const outside=await tools.search({path:owners,query:"outside()"});
if(outside.status!=="success" || outside.data.matches.length!==0) throw Error("Sparse gap widened");
const partial=await tools.search({path:"a.ts",query:"ast:$NAME()",limit:1});
const incomplete=await tools.select({path:partial,operation:${enclosing}});
if(incomplete.status!=="success" || incomplete.data.complete!==false) throw Error("Completeness discarded");
const partialRead=await tools.read({path:incomplete.data.target});
const stillPartial=await tools.select({path:partialRead,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
if(stillPartial.status!=="success" || stillPartial.data.complete!==false) throw Error("Read laundered completeness");
const noEdit=await tools.replace({path:incomplete.data.items,text:"BAD"});
if(noEdit.status!=="error" || noEdit.data.effect!=="not-applied") throw Error("Incomplete Select granted writes");
const empty=await tools.select({path:[],operation:${enclosing}});
if(empty.status!=="success" || !empty.data.complete || empty.data.totalItems!==0) throw Error("Empty target set rejected");
const missing=await tools.search({path:"a.ts",query:"notFound"});
const none=await tools.select({path:missing.data,operation:${enclosing}});
if(none.status!=="success" || none.data.totalItems!==0) throw Error("Empty Search not supported");
for(const [path,operation,code] of [
 ["a.ts",${enclosing},"AMBIGUOUS_SEED"],
 [a,{kind:"part",part:"body"},"UNSUPPORTED_PART_INPUT"],
 ["other.py",${enclosing},"UNSUPPORTED_LANGUAGE"],
 [{target:"RESULT#forged"},${enclosing},"SELECT_FAILED"],
 [{source:"a.ts",range:a.data.matches[0].range},${enclosing},"SELECT_FAILED"]
]){
 const refused=await tools.select({path,operation});
 if(refused.status!=="error" || refused.errors[0].code!==code || refused.data?.target) throw Error("Unsafe structural input accepted: "+JSON.stringify(refused));
}
text({files:2,owners:2,complete:incomplete.data.complete,refusals:5});`,
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
const owners=await tools.select({path:seed,operation:${enclosing}});
if(owners.status!=="success" || owners.data.totalItems!==105 || !owners.data.truncated || owners.data.items.length!==100 || !owners.data.complete) throw Error("Preview completeness confused");
const every=await tools.search({path:owners.data.target,query:"probe()",limit:200});
if(every.status!=="success" || every.data.matches.length!==100 || !every.data.truncated || !every.data.complete) throw Error("Search preview contract changed");
const beyond=await tools.search({path:owners.data.target,query:"ast:function f104() { $$$BODY }"});
if(beyond.status!=="success" || beyond.data.matches.length!==1) throw Error("Top-level target clipped to preview");
const direct=await tools.select({path:"big.ts",operation:${enclosing}});
if(direct.status!=="success" || !direct.data.items[0].textTruncated || direct.data.items[0].preview.length>1000) throw Error("Unbounded preview");
const tail=await tools.search({path:direct,query:"tail()"});
if(tail.status!=="success" || tail.data.matches.length!==1) throw Error("Text preview clipped authority");
const compact=await tools.select({path:"medium.ts",operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
if(compact.status!=="success" || compact.data.items[0].textTruncated || compact.data.items[0].preview.length<120) throw Error("Medium preview fixture invalid");
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
const owner=await tools.select({path:seed,operation:${enclosing}});
const body=await tools.select({path:owner,operation:{kind:"part",part:"body"}});
const found=await tools.search({path:body,query:"format_me()"});
const changed=await tools.replace({path:found,text:"final_format_me()"});
if(changed.status!=="success") throw Error(JSON.stringify(changed.errors));
const current=await tools.select({path:changed,operation:${enclosing}});
if(current.status!=="success" || !current.data.items[0].preview.includes("final_format_me()")) throw Error("Selection ran formatting early");
store("pre-format-selection",current.data.target);
text({unformattedInsideScript:true});`,
        `const stale=await tools.select({path:load("pre-format-selection"),operation:${enclosing}});
if(stale.status!=="error" || !/stale/.test(stale.errors[0].message) || stale.data?.target) throw Error("Formatted selection silently refreshed");
const refused=await tools.replace({path:load("pre-format-selection"),text:"BAD"});
if(refused.status!=="error" || refused.data.effect!=="not-applied") throw Error("Formatted selection granted edits");
const fresh=await tools.search({path:"select-format.ts",query:"final_FORMATTED()"});
if(fresh.status!=="success" || fresh.data.matches.length!==1) throw Error("Final processing missing");
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
if(changed.status!=="success" || changed.data.effect!=="pending") throw Error("Expected pending write");
const owner=await tools.select({path:changed,operation:${enclosing}});
if(owner.status!=="success" || owner.data.totalItems!==1) throw Error("Pending Select did not confirm its source");
const body=await tools.select({path:owner.data.items[0],operation:{kind:"part",part:"body"}});
store("selection-body",body.data.target);
text({pendingConsumed:true,owner:owner.data.items[0].range});`,
      `const target=load("selection-body");
const body=await tools.select({path:target,operation:${enclosing}});
if(body.status!=="success" || body.data.totalItems!==1) throw Error("Cross-call target expired early");
const refusedWrite=await tools.write({path:{target},content:"BAD"});
const refusedUndo=await tools.undo({file:{target},change:"last"});
for(const refused of [refusedWrite,refusedUndo]) if(refused.status!=="error" || refused.data.effect!=="not-applied") throw Error("Partial Select widened whole-file operation");
const found=await tools.search({path:target,query:"probe()"});
const edited=await tools.replace({path:found,text:"done()"});
if(edited.status!=="success") throw Error(JSON.stringify(edited.errors));
const stale=await tools.select({path:target,operation:${enclosing}});
if(stale.status!=="error" || !/stale/.test(stale.errors[0].message) || stale.data?.target) throw Error("Stale Select silently refreshed");
const noEdit=await tools.replace({path:target,text:"BAD"});
if(noEdit.status!=="error" || noEdit.data.effect!=="not-applied") throw Error("Stale Select edited new bytes");
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
const owner=await tools.select({path:window,operation:${enclosing}});
if(owner.status!=="success" || owner.data.totalItems!==1) throw Error("Narrow Read has no owner: "+JSON.stringify(owner));
const item=owner.data.items[0];
if(item.range.startColumn!==6 || item.range.endLine!==3 || item.range.endColumn!==1 || !item.origins[0].expanded) throw Error("Wrong expansion coordinates");
for(const path of [owner,owner.data,owner.data.target,owner.data.items,[item,item]]){
 const same=await tools.select({path,operation:${enclosing}});
 if(same.status!=="success" || same.data.totalItems!==1 || JSON.stringify(same.data.items[0].range)!==JSON.stringify(item.range)) throw Error("Selection input form lost geometry");
}
const direct=await tools.select({path:"direct.js",operation:${enclosing}});
if(direct.status!=="success" || direct.data.totalItems!==1) throw Error("Whole-file exact function unsupported");
const body=await tools.select({path:item,operation:{kind:"part",part:"body"}});
if(body.status!=="success" || body.data.items[0].preview.split(String.fromCharCode(13,10)).join("|")!=="{| probe();|}") throw Error("Body lost CRLF");
const preview=await tools.read({path:body.data.target});
if(preview.status!=="success") throw Error("Selection Read unavailable");
const escaped=await tools.search({path:preview,query:"😀"});
if(escaped.status!=="success" || escaped.data.matches.length!==0) throw Error("Read context widened selection authority");
const after=await tools.search({path:preview,query:"other()"});
if(after.status!=="success" || after.data.matches.length!==0) throw Error("Read exposed same-line neighbor");
const closer=await tools.search({path:preview,query:"}"});
if(closer.status!=="success" || closer.data.matches.length!==1) throw Error("Read omitted closing body line");
const found=await tools.search({path:body,query:"probe()"});
if(found.status!=="success" || found.data.matches.length!==1) throw Error("Body Search unavailable");
const changed=await tools.replace({path:found,text:"done()"});
if(changed.status!=="success") throw Error(JSON.stringify(changed.errors));
text({owner:item.range,expanded:true});`,
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
if(calls.status!=="success" || calls.data.matches.length!==5) throw Error("Missing fixture calls");
const owners=await tools.select({path:calls,operation:${enclosing}});
if(owners.status!=="success") throw Error(JSON.stringify(owners.errors));
if(owners.data.totalItems!==4 || owners.data.items[0].origins.length!==2) throw Error("Owner dedup lost call association");
const accepted=[];
for(const owner of owners.data.items){
 const body=await tools.select({path:owner,operation:{kind:"part",part:"body"}});
 if(body.status!=="success" || body.data.totalItems!==1) throw Error("Missing body");
 const retry=await tools.search({path:body.data,query:"ast:retry($$$ARGS)"});
 if(retry.status!=="success" || !retry.data.complete) throw Error("Incomplete retry predicate");
 const retryOwners=await tools.select({path:retry.data.matches,operation:${enclosing}});
 if(retryOwners.status!=="success") throw Error(JSON.stringify(retryOwners.errors));
 const identity=i=>JSON.stringify([i.source,i.range]);
 if(retryOwners.data.items.some(i=>identity(i)===identity(owner))) accepted.push(owner);
}
if(accepted.length!==2) throw Error("Nested retry counted or callback retry dropped");
const values=[];
for(const owner of accepted){
 const eligible=calls.data.matches.filter(call=>owner.origins.some(o=>JSON.stringify(o.range)===JSON.stringify(call.range)));
 for(const call of eligible){
  const patterns=["legacyRequest({ timeout: $VALUE })","legacyRequest({ $$$BEFORE, timeout: $VALUE })","legacyRequest({ timeout: $VALUE, $$$AFTER })","legacyRequest({ $$$BEFORE, timeout: $VALUE, $$$AFTER })"];
  const projected=await Promise.all(patterns.map(pattern=>tools.search({path:call,query:"ast:"+pattern})));
  const seen=new Set();
  for(const property of projected){
   if(property.status!=="success" || !property.data.complete) throw Error("Incomplete inline options projection");
   for(const match of property.data.matches.filter(m=>JSON.stringify(m.range)===JSON.stringify(call.range))){
    for(const value of match.captures.VALUE){
     const key=JSON.stringify(value.range);
     if(!seen.has(key)){ seen.add(key); values.push(value); }
    }
   }
  }
 }
}
if(values.length!==3) throw Error("Unrelated options included");
const preview=await tools.read({path:values[0].target});
if(preview.status!=="success") throw Error("Selection captures unreadable");
const changed=await tools.replace({path:values,text:"99"});
if(changed.status!=="success") throw Error(JSON.stringify(changed.errors));
text({owners:owners.data.totalItems,eligible:accepted.length,timeouts:values.length});`,
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
