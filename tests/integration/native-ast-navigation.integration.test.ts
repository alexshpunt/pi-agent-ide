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

async function runNavigation(cwd: string, name: string, scripts: readonly string[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
  );
  const run = await new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: true,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "select", "replace", "write", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `navigation-${index}`,
              name: "codemode",
              arguments: { code: textResultChecks + code },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("AST navigation finished.")]),
    ],
  }).run("Navigate verified JS/TS constructs and edit only the intended part");
  for (let index = 0; index < scripts.length; index++)
    expect(
      getToolExecution(run, `navigation-${index}`).isError,
      getToolResultText(run, `navigation-${index}`),
    ).toBe(false);
  return run;
}

test("navigates normalized ownership and branches before editing one argument with CRLF neighbors intact", async () => {
  await withTempWorkspace(async (cwd) => {
    const source =
      '"😀"; function outer() {\r\n if (ready) { send(() => finish(10)); } else fallback(20);\r\n other(30);\r\n}';
    await writeFile(path.join(cwd, "calls.ts"), source);
    const run = await runNavigation(cwd, "ast-navigation-chain", [
      `const found=await tools.search({path:"calls.ts",query:"ast:finish($VALUE)"});
const call=await tools.select({path:found,operation:{kind:"object",object:"call"}});
const callback=await tools.select({path:call,operation:{kind:"navigate",relation:"parent"}});
const owner=await tools.select({path:call,operation:{kind:"object",object:"function",relation:"enclosing",level:2,extent:"around"}});
const ancestors=await tools.select({path:call,operation:{kind:"navigate",relation:"ancestors"}});
if(!callback.includes(" function"+String.fromCharCode(10))||items(owner)[0].startColumn!==6||!ancestors.includes("4 selection(s)"))throw Error("Owner chain lost");
const children=await tools.select({path:owner,operation:{kind:"navigate",relation:"children",object:"call"}});
if(items(children).length!==1||!children.endsWith("other(30)"))throw Error("Filter changed topology");
const outerCalls=await tools.select({path:owner,operation:{kind:"navigate",relation:"descendants",object:"call"}});
if(items(outerCalls).length!==4)throw Error("Descendants lost");
await rejects(()=>tools.replace({path:ancestors,text:"BAD"}),/[Oo]verlap/);
const args=await tools.select({path:call,operation:{kind:"part",part:"arguments"}});
store("navigationOld",args);
const preview=await tools.read({path:args});
const escaped=await tools.search({path:preview,query:"20"});
if(matches(escaped).length)throw Error("Part Read widened authority");
const number=await tools.search({path:args,query:"10"});
text(await tools.replace({path:number,text:"99"}));`,
      `await rejects(()=>tools.select({path:load("navigationOld"),operation:{kind:"navigate",relation:"parent"}}),/expired|stale/);
const ifs=await tools.search({path:"calls.ts",query:"ast:if ($COND) { $$$BODY } else $ELSE"});
const condition=await tools.select({path:ifs,operation:{kind:"part",part:"condition"}});
if(!condition.endsWith("(ready)"))throw Error("Condition lost delimiters");
const branch=await tools.select({path:ifs,operation:{kind:"part",part:"else"}});
const calls=await tools.select({path:branch,operation:{kind:"navigate",relation:"children"}});
if(!calls.endsWith("fallback(20)"))throw Error("Else part was not composable");
text({staleRejected:true,branchCalls:items(calls).length});`,
    ]);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(
      source.replace("finish(10)", "finish(99)"),
    );
    expect(getToolResultText(run, "navigation-1")).toContain("branchCalls");
    expect(getToolResultText(run, "navigation-0")).toContain("calls.ts");
  });
});

test("navigates pending writes, sibling directions and cross-call part targets without hidden owner expansion", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runNavigation(cwd, "ast-navigation-pending-siblings", [
      `const written=await tools.write({path:"pending.js",content:"first(1); second(2); third(3);"});
const second=await tools.search({path:written,query:"ast:second($V)"});
const previous=await tools.select({path:second,operation:{kind:"navigate",relation:"siblings",direction:"previous"}});
const next=await tools.select({path:second,operation:{kind:"navigate",relation:"siblings",direction:"next"}});
const all=await tools.select({path:second,operation:{kind:"navigate",relation:"siblings"}});
if(!previous.endsWith("first(1)")||!next.endsWith("third(3)")||items(all).length!==2)throw Error("Siblings lost");
const partial=await tools.search({path:written,query:"econd"});
await rejects(()=>tools.select({path:partial,operation:{kind:"navigate",relation:"parent"}}),/exact syntax node/);
const args=await tools.select({path:next,operation:{kind:"part",part:"arguments"}});
store("navigationPart",args);
text({siblings:items(all).length,partialRejected:true});`,
      `const part=await tools.read({path:load("navigationPart")});
const value=await tools.search({path:part,query:"3"});
if(matches(value).length!==1)throw Error("Cross-call part expired");
text(await tools.replace({path:value,text:"9"}));`,
    ]);
    expect(await readFile(path.join(cwd, "pending.js"), "utf8")).toBe(
      "first(1); second(2); third(9);",
    );
    expect(run.tuiRenderedOutput).toContain("pending.js");
  });
});

test("retains full navigation beyond previews and rejects incomplete or unsupported requests honestly", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "many.js"),
      `function many() { ${Array.from({ length: 105 }, (_, i) => `call${i}();`).join(" ")} }`,
    );
    await runNavigation(cwd, "ast-navigation-preview-refusals", [
      `const source=await tools.read({path:"many.js"});
const owner=await tools.select({path:source,operation:{kind:"object",object:"function",relation:"enclosing",level:1,extent:"around"}});
const all=await tools.select({path:owner,operation:{kind:"navigate",relation:"descendants",object:"call"}});
if(!all.includes("105 selection(s)")||items(all).length!==100||!all.includes("more selections")||all.includes("incomplete"))throw Error("Navigation preview clipped target");
const tail=await tools.search({path:all,query:"call104"});
if(matches(tail).length!==1)throw Error("Last descendant lost");
const limited=await tools.search({path:"many.js",query:"ast:$CALL()",limit:1});
const partial=await tools.select({path:limited,operation:{kind:"navigate",relation:"parent"}});
check(partial.includes("incomplete input"),"Navigation laundered completeness");
await rejects(()=>tools.replace({path:partial,text:"BAD"}),/[Ii]ncomplete/);
const call=items(all)[0].ref;
await rejects(()=>tools.select({path:call,operation:{kind:"part",part:"body"}}),/callee, arguments/);
const functions=await tools.select({path:call,operation:{kind:"object",object:"function",relation:"enclosing",level:2,extent:"around"}});
if(items(functions).length!==0||!functions.includes("1 input(s) without a selection"))throw Error("Absence became error");
text({fullCount:105,absent:0,unsupportedRejected:true});`,
    ]);
    expect((await readFile(path.join(cwd, "many.js"), "utf8")).endsWith("call104(); }")).toBe(true);
  });
});

test("ordinary Select exposes enclosing levels and normalized metadata without Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "function outer() { return () => inner(); }";
    await writeFile(path.join(cwd, "ordinary.js"), source);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    const run = await new PiIntegrationTest({
      testName: "ast-navigation-ordinary",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["select"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "ordinary",
              name: "select",
              arguments: {
                path: "ordinary.js",
                operation: { kind: "navigate", relation: "descendants", object: "function" },
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Ordinary AST navigation finished.")]),
      ],
    }).run("Find the nested function using ordinary Select");
    expect(getToolExecution(run, "ordinary").isError, getToolResultText(run, "ordinary")).toBe(
      false,
    );
    expect(getToolResultText(run, "ordinary")).toMatch(/ function\n/u);
    expect(run.tuiRenderedOutput).toContain("descendants");
    expect(run.tuiRenderedOutput).toContain("1 selection in 1 file");
    expect(await readFile(path.join(cwd, "ordinary.js"), "utf8")).toBe(source);
  });
});
