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
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "select", "replace", "delete", "copy", "move", "write", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `element-${index}`, name: "codemode", arguments: { code } })],
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
const argument=await tools.select({path:calls.data.matches[0].captures.MIDDLE,operation:{kind:"elementExtent",extent:"around"}});
if(argument.status!=="success"||argument.data.items[0].preview!=="middle(2), ")throw Error("Argument comma lost");
store("elementOld",argument.data.target);
text(await tools.delete({path:argument}));
const params=await tools.search({path:"parameters.ts",query:"middle = { /* inside */ value: 2 }"});
const parameter=await tools.select({path:params,operation:{kind:"elementExtent",extent:"around"}});
if(parameter.status!=="success"||parameter.data.items[0].preview!=="middle = { /* inside */ value: 2 }, ")throw Error("Parameter comma lost");
text(await tools.delete({path:parameter}));`,
      `const stale=await tools.select({path:load("elementOld"),operation:{kind:"elementExtent",extent:"inside"}});
if(stale.status!=="error"||stale.data?.target)throw Error("Stale list target refreshed");
for(const file of ["calls.ts","parameters.ts"]){
 const tree=await tools.select({path:file,operation:{kind:"navigate",relation:"children"}});
 if(tree.status!=="success")throw Error("Removal left invalid syntax");
}
text({staleRejected:true,validSources:2});`,
    ]);
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe(
      '"😀"; source(first(1), last(3));\r\nprotectedCall(9);',
    );
    expect(await readFile(path.join(cwd, "parameters.ts"), "utf8")).toBe(
      "function source(first: T, ...last: T[]) {}\r\nconst protectedValue = 9;",
    );
    expect(run.tuiRenderedOutput).toContain("parameters.ts");
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
const extent=await tools.select({path:calls.data.matches[0].captures.MIDDLE,operation:{kind:"elementExtent",extent:"around"}});
const destination=await tools.search({path:"destination.js",query:"ast:destination($ARG)"});
const point=await tools.select({path:destination.data.matches[0].captures.ARG,operation:{kind:"position",edge:"before"}});
const transferred=await tools.${operation}({path:extent,target:point});
if(transferred.status!=="success")throw Error("Transfer failed");
const found=await tools.search({path:transferred,query:"ast:middle($VALUE)"});
if(found.status!=="success"||found.data.matches.length!==1)throw Error("Transfer target lost");
text(await tools.replace({path:found,text:"middle(99)"}));
for(const file of ["source.js","destination.js"]){
 const parsed=await tools.select({path:file,operation:{kind:"navigate",relation:"children"}});
 if(parsed.status!=="success")throw Error("Transfer left invalid syntax");
}`,
      ]);
      expect(await readFile(path.join(cwd, "source.js"), "utf8")).toBe(
        operation === "copy" ? source : source.replace("middle(2), ", ""),
      );
      expect(await readFile(path.join(cwd, "destination.js"), "utf8")).toBe(
        "destination(middle(99), anchor(4));\r\nprotectedCall(8);",
      );
      expect(run.tuiRenderedOutput).toContain("destination.js");
    });
  });

test("retains pending element extents beyond previews and refuses unsafe ownership or incomplete authority", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "unsafe.js"), "f(a, /* note */ b); array = [first, second];");
    await runElements(cwd, "element-refusals-preview", [
      `const pending=await tools.write({path:"many.js",content:"f("+Array.from({length:105},(_,i)=>"value"+i).join(", ")+");"});
const args=await tools.search({path:pending,query:"ast:f($$$ARGS)"});
const elements=args.data.matches[0].captures.ARGS.filter(c=>/^value[0-9]+$/.test(c.matchedText));
const all=await tools.select({path:elements,operation:{kind:"elementExtent",extent:"around"}});
if(all.status!=="success"||all.data.totalItems!==105||all.data.items.length!==100||!all.data.truncated||!all.data.complete)throw Error("Preview lost extents");
const tail=await tools.search({path:all.data.target,query:"value104"});
if(tail.data.matches.length!==1)throw Error("Last item lost");
const overlapping=await tools.replace({path:all,text:"BAD"});
if(overlapping.status!=="error"||overlapping.data.effect!=="not-applied")throw Error("Overlapping ownership edited");
const limitedSource=await tools.write({path:"limited.js",content:"f(value0); f(value1);"});
const limited=await tools.search({path:limitedSource,query:"ast:f($ARG)",limit:1});
const partial=await tools.select({path:limited.data.matches[0].captures.ARG,operation:{kind:"elementExtent",extent:"around"}});
const noEdit=await tools.delete({path:partial});
if(partial.data.complete||noEdit.status!=="error"||noEdit.data.effect!=="not-applied")throw Error("Completeness laundered");
for(const [query,code]of [["a","AMBIGUOUS_LIST_TRIVIA"],["first","EXACT_LIST_ELEMENT_REQUIRED"]]){
 const seed=await tools.search({path:"unsafe.js",query});
 const result=await tools.select({path:seed.data.matches.slice(0,1),operation:{kind:"elementExtent",extent:"around"}});
 if(result.status!=="error"||result.errors[0].code!==code||result.data?.target)throw Error("Unsafe ownership accepted: "+JSON.stringify(result));
}
const empty=await tools.select({path:[],operation:{kind:"elementExtent",extent:"around"}});
if(empty.status!=="success"||empty.data.totalItems!==0)throw Error("Empty set widened");
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
