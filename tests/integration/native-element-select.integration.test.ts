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

async function runElements(cwd: string, name: string, scripts: readonly string[]) {
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
    tools: ["read", "search", "select", "replace", "delete", "copy", "move", "write", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `element-${index}`,
              name: "codemode",
              arguments: { code: textResultChecks + code },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("List element composition finished.")]),
    ],
  }).run("Select source-backed list extents and edit only their owned bytes");
  for (let index = 0; index < scripts.length; index++)
    expect(
      getToolExecution(run, `element-${index}`).isError,
      getToolResultText(run, `element-${index}`),
    ).toBe(false);
  return run;
}

test("deletes an argument and typed parameter with exact CRLF neighbors and keeps valid syntax", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "calls.ts"),
      '"😀"; source(first(1), middle(2), last(3));\r\nprotectedCall(9);',
    );
    await writeFile(
      path.join(cwd, "parameters.ts"),
      "function source(first: T, middle = { /* inside */ value: 2 }, ...last: T[]) {}\r\nconst protectedValue = 9;",
    );
    const run = await runElements(cwd, "element-delete-crlf", [
      `const calls=await tools.search({path:"calls.ts",query:"ast:source($FIRST, $MIDDLE, $LAST)"});
const argument=await tools.select({path:capture(calls,"MIDDLE"),operation:{kind:"elementExtent",extent:"around"}});
if(!argument.endsWith("middle(2), "))throw Error("Argument comma lost");
store("elementOld",argument);
text(await tools.delete({path:argument}));
const params=await tools.search({path:"parameters.ts",query:"middle = { /* inside */ value: 2 }"});
const parameter=await tools.select({path:params,operation:{kind:"elementExtent",extent:"around"}});
if(!parameter.endsWith("middle = { /* inside */ value: 2 }, "))throw Error("Parameter comma lost");
text(await tools.delete({path:parameter}));`,
      `await rejects(()=>tools.select({path:load("elementOld"),operation:{kind:"elementExtent",extent:"inside"}}),/expired|stale/);
for(const file of ["calls.ts","parameters.ts"]){
 const tree=await tools.select({path:file,operation:{kind:"navigate",relation:"children"}});
 check(items(tree).length>0,"Removal left invalid syntax");
}
text({staleRejected:true,validSources:2});`,
    ]);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(
      '"😀"; source(first(1), last(3));\r\nprotectedCall(9);',
    );
    expect(await readFile(path.join(cwd, "parameters.ts"), "utf8")).toBe(
      "function source(first: T, ...last: T[]) {}\r\nconst protectedValue = 9;",
    );
    expect(getToolResultText(run, "element-0")).toContain("parameters.ts");
  });
});

for (const operation of ["copy", "move"] as const)
  test(`${operation} transports the following separator into an exact destination point`, async () => {
    await withTempWorkspace(async (cwd) => {
      const source = '"😀"; source(first(1), middle(2), last(3));\r\nprotectedCall(9);';
      await writeFile(path.join(cwd, "source.js"), source);
      await writeFile(
        path.join(cwd, "destination.js"),
        "destination(anchor(4));\r\nprotectedCall(8);",
      );
      const run = await runElements(cwd, `element-${operation}-point`, [
        `const calls=await tools.search({path:"source.js",query:"ast:source($FIRST, $MIDDLE, $LAST)"});
const extent=await tools.select({path:capture(calls,"MIDDLE"),operation:{kind:"elementExtent",extent:"around"}});
const destination=await tools.search({path:"destination.js",query:"ast:destination($ARG)"});
const point=await tools.select({path:capture(destination,"ARG"),operation:{kind:"position",edge:"before"}});
const transferred=await tools.${operation}({path:extent,target:point});
check(typeof transferred==="string","Transfer failed");
const found=await tools.search({path:transferred,query:"ast:middle($VALUE)"});
if(matches(found).length!==1)throw Error("Transfer target lost");
text(await tools.replace({path:found,text:"middle(99)"}));
for(const file of ["source.js","destination.js"]){
 const parsed=await tools.select({path:file,operation:{kind:"navigate",relation:"children"}});
 check(items(parsed).length>0,"Transfer left invalid syntax");
}`,
      ]);
      expect(await readFile(path.join(cwd, "source.js"), "utf8")).toBe(
        operation === "copy" ? source : source.replace("middle(2), ", ""),
      );
      expect(await readFile(path.join(cwd, "destination.js"), "utf8")).toBe(
        "destination(middle(99), anchor(4));\r\nprotectedCall(8);",
      );
      expect(getToolResultText(run, "element-0")).toContain("destination.js");
    });
  });

test("retains pending element extents beyond previews and refuses unsafe ownership or incomplete authority", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "unsafe.js"), "f(a, /* note */ b); array = [first, second];");
    await runElements(cwd, "element-refusals-preview", [
      `const pending=await tools.write({path:"many.js",content:"f("+Array.from({length:105},(_,i)=>"value"+i).join(", ")+");"});
const args=await tools.search({path:pending,query:"ast:f($$$ARGS)"});
const elements=await tools.search({path:args,query:"regex:value[0-9]+",limit:200});
const all=await tools.select({path:elements,operation:{kind:"elementExtent",extent:"around"}});
if(!all.includes("105 selection(s)")||items(all).length!==100||!all.includes("more selections")||all.includes("incomplete"))throw Error("Preview lost extents");
const tail=await tools.search({path:all,query:"value104"});
if(matches(tail).length!==1)throw Error("Last item lost");
await rejects(()=>tools.replace({path:all,text:"BAD"}),/[Oo]verlap/);
const limitedSource=await tools.write({path:"limited.js",content:"f(value0); f(value1);"});
const limited=await tools.search({path:limitedSource,query:"ast:f($ARG)",limit:1});
const partial=await tools.select({path:capture(limited,"ARG"),operation:{kind:"elementExtent",extent:"around"}});
check(partial.includes("incomplete input"),"Completeness laundered");
await rejects(()=>tools.delete({path:partial}),/[Ii]ncomplete/);
for(const [query,code]of [["a","AMBIGUOUS_LIST_TRIVIA"],["first","EXACT_LIST_ELEMENT_REQUIRED"]]){
 const seed=await tools.search({path:"unsafe.js",query});
 await rejects(()=>tools.select({path:matches(seed)[0],operation:{kind:"elementExtent",extent:"around"}}),new RegExp(code==="AMBIGUOUS_LIST_TRIVIA" ? "[Cc]omment|[Tt]rivia" : "exact direct call argument"));
}
const empty=await tools.select({path:[],operation:{kind:"elementExtent",extent:"around"}});
if(items(empty).length!==0)throw Error("Empty set widened");
text({all:105,preview:100,refusals:4,empty:0});`,
    ]);
    expect(await readFile(path.join(cwd, "many.js"), "utf8")).toBe(
      `f(${Array.from({ length: 105 }, (_, i) => `value${i}`).join(", ")});`,
    );
    expect(await readFile(path.join(cwd, "unsafe.js"), "utf8")).toBe(
      "f(a, /* note */ b); array = [first, second];",
    );
  });
});
