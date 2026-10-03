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
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "select", "replace", "write", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `navigation-${index}`, name: "codemode", arguments: { code } })],
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
const callback=await tools.select({path:call.data,operation:{kind:"navigate",relation:"parent"}});
const owner=await tools.select({path:call.data.target,operation:{kind:"object",object:"function",relation:"enclosing",level:2,extent:"around"}});
const ancestors=await tools.select({path:call,operation:{kind:"navigate",relation:"ancestors"}});
if(callback.data.items[0].syntax.object!=="function"||owner.data.items[0].range.startColumn!==6||ancestors.data.items.map(i=>i.syntax.object).join(",")!=="function,if,call,function")throw Error("Owner chain lost");
const children=await tools.select({path:owner.data.items,operation:{kind:"navigate",relation:"children",object:"call"}});
if(children.data.totalItems!==1||children.data.items[0].preview!=="other(30)")throw Error("Filter changed topology");
const outerCalls=await tools.select({path:owner,operation:{kind:"navigate",relation:"descendants",object:"call"}});
if(outerCalls.data.totalItems!==4)throw Error("Descendants lost");
const overlap=await tools.replace({path:ancestors,text:"BAD"});
if(overlap.status!=="error"||overlap.data.effect!=="not-applied")throw Error("Overlapping ancestors became editable");
const args=await tools.select({path:call,operation:{kind:"part",part:"arguments"}});
store("navigationOld",args.data.target);
const preview=await tools.read({path:args.data.target});
const escaped=await tools.search({path:preview,query:"20"});
if(escaped.data.matches.length)throw Error("Part Read widened authority");
const number=await tools.search({path:args,query:"10"});
text(await tools.replace({path:number,text:"99"}));`,
      `const refused=await tools.select({path:load("navigationOld"),operation:{kind:"navigate",relation:"parent"}});
if(refused.status!=="error"||refused.data?.target)throw Error("Stale part acquired authority");
const ifs=await tools.search({path:"calls.ts",query:"ast:if ($COND) { $$$BODY } else $ELSE"});
const condition=await tools.select({path:ifs,operation:{kind:"part",part:"condition"}});
if(condition.data.items[0].preview!=="(ready)")throw Error("Condition lost delimiters");
const branch=await tools.select({path:ifs,operation:{kind:"part",part:"else"}});
const calls=await tools.select({path:branch,operation:{kind:"navigate",relation:"children"}});
if(calls.data.items[0].preview!=="fallback(20)")throw Error("Else part was not composable");
text({staleRejected:true,branchCalls:calls.data.totalItems});`,
    ]);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(
      source.replace("finish(10)", "finish(99)"),
    );
    expect(run.tuiRenderedOutput).toContain("children");
    expect(run.tuiRenderedOutput).toContain("calls.ts");
  });
});

test("navigates pending writes, sibling directions and cross-call part targets without hidden owner expansion", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runNavigation(cwd, "ast-navigation-pending-siblings", [
      `const written=await tools.write({path:"pending.js",content:"first(1); second(2); third(3);"});
const second=await tools.search({path:written,query:"ast:second($V)"});
const previous=await tools.select({path:second,operation:{kind:"navigate",relation:"siblings",direction:"previous"}});
const next=await tools.select({path:second.data.target,operation:{kind:"navigate",relation:"siblings",direction:"next"}});
const all=await tools.select({path:second.data.matches,operation:{kind:"navigate",relation:"siblings"}});
if(previous.data.items[0].preview!=="first(1)"||next.data.items[0].preview!=="third(3)"||all.data.totalItems!==2)throw Error("Siblings lost");
const partial=await tools.search({path:written,query:"econd"});
const refused=await tools.select({path:partial,operation:{kind:"navigate",relation:"parent"}});
if(refused.status!=="error"||refused.errors[0].code!=="EXACT_NODE_REQUIRED")throw Error("Partial seed silently expanded");
const args=await tools.select({path:next,operation:{kind:"part",part:"arguments"}});
store("navigationPart",args.data.target);
text({siblings:all.data.totalItems,partialRejected:true});`,
      `const part=await tools.read({path:load("navigationPart")});
const value=await tools.search({path:part,query:"3"});
if(value.data.matches.length!==1)throw Error("Cross-call part expired");
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
if(all.data.totalItems!==105||all.data.items.length!==100||!all.data.truncated||!all.data.complete)throw Error("Navigation preview clipped target");
const tail=await tools.search({path:all.data.target,query:"call104"});
if(tail.data.matches.length!==1)throw Error("Last descendant lost");
const limited=await tools.search({path:"many.js",query:"ast:$CALL()",limit:1});
const partial=await tools.select({path:limited,operation:{kind:"navigate",relation:"parent"}});
const noEdit=await tools.replace({path:partial,text:"BAD"});
if(partial.data.complete||noEdit.status!=="error"||noEdit.data.effect!=="not-applied")throw Error("Navigation laundered completeness");
const call=all.data.items[0];
const unsupported=await tools.select({path:call,operation:{kind:"part",part:"body"}});
if(unsupported.status!=="error"||unsupported.errors[0].code!=="UNSUPPORTED_PART"||!unsupported.errors[0].message.includes("callee, arguments"))throw Error("Missing actionable error");
const functions=await tools.select({path:call,operation:{kind:"object",object:"function",relation:"enclosing",level:2,extent:"around"}});
if(functions.data.totalItems!==0||functions.data.missingInputs!==1)throw Error("Absence became error");
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
    expect(getToolResultText(run, "ordinary")).toContain('"syntax":{"object":"function"}');
    expect(run.tuiRenderedOutput).toContain("descendants");
    expect(run.tuiRenderedOutput).toContain("1 selection in 1 file");
    expect(await readFile(path.join(cwd, "ordinary.js"), "utf8")).toBe(source);
  });
});
