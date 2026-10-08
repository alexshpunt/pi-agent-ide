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

async function runTextSelection(cwd: string, name: string, scripts: readonly string[]) {
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
    rawMode: name !== "text-select-pending-preview",
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "select", "replace", "copy", "write", "undo", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `text-${index}`,
              name: "codemode",
              arguments: { code: textResultChecks + code },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Text selection finished.")]),
    ],
  }).run("Compose verified text boundaries through Select and existing tools");
  for (let index = 0; index < scripts.length; index++)
    expect(
      getToolExecution(run, `text-${index}`).isError,
      getToolResultText(run, `text-${index}`),
    ).toBe(false);
  return run;
}

test("composes sparse text transforms and zero-width transfers with exact CRLF neighbors", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "notes.txt"),
      "outside\r\n😀 < one,two > keep\r\n< three > keep\r\noutside",
    );
    await writeFile(path.join(cwd, "other.txt"), "< four > protected");
    await runTextSelection(cwd, "text-select-composition", [
      `const read=await tools.read({path:"notes.txt",offset:2,limit:2});
const other=await tools.search({path:"other.txt",query:"< four >"});
const selected=await tools.select({path:[read,other],operation:{kind:"between",start:"<",end:">",extent:"inside"}});
check(items(selected).length===3,"Sparse pairs lost");
const trimmed=await tools.select({path:selected,operation:{kind:"trim",side:"both"}});
check(items(trimmed)[0].startColumn===5,"UTF16 columns lost");
const pieces=await tools.select({path:trimmed,operation:{kind:"split",delimiter:","}});
check(items(pieces).length===4,"Split segments lost");
const one=await tools.select({path:items(pieces)[0].ref,operation:{kind:"sliceText",from:0,to:3}});
store("oldTextTarget",one);
const preview=await tools.read({path:one});
check(matches(await tools.search({path:preview,query:"outside"})).length===0,"Read widened text scope");
const points=await tools.select({path:items(pieces)[3].ref,operation:{kind:"position",edge:"before"}});
await tools.copy({path:one,target:points});
const fresh=await tools.search({path:"notes.txt",query:"one"});
text(await tools.replace({path:matches(fresh)[0],text:"ONE"}));`,
      `await rejects(()=>tools.replace({path:load("oldTextTarget"),text:"BAD"}),/expired|stale/);
const source=await tools.read({path:"notes.txt"});
const selected=await tools.select({path:source,operation:{kind:"lines",first:2,last:3}});
const columns=await tools.select({path:selected,operation:{kind:"columns",from:0,to:2}});
check(items(columns).length===2 && columns.includes("😀"),"Columns or line endings lost");
const range=await tools.select({path:source,operation:{kind:"range",startLine:2,startColumn:5,endLine:2,endColumn:8}});
check(range.endsWith(String.fromCharCode(10)+"ONE"),"Absolute range failed");
const expanded=await tools.select({path:range,operation:{kind:"linesOf"}});
check(items(expanded)[0].endLine===3 && items(expanded)[0].endColumn===0,"Line expansion wrong");
text({staleRejected:true,columns:2,absoluteRange:true,expanded:true});`,
    ]);
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(
      "outside\r\n😀 < ONE,two > keep\r\n< three > keep\r\noutside",
    );
    expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("< onefour > protected");
  });
});

test("protects gaps, bounds, emoji, CRLF, completeness and whole-file guards", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "😀 <A> keep\r\nx\r\n<unfinished";
    await writeFile(path.join(cwd, "safe.txt"), source);
    await writeFile(path.join(cwd, "limited.js"), "first(); second();");
    await runTextSelection(cwd, "text-select-refusals", [
      `const full=await tools.read({path:"safe.txt"});
const piece=await tools.search({path:"safe.txt",query:"A"});
const partial=await tools.search({path:"limited.js",query:"ast:$NAME()",limit:1});
const incomplete=await tools.select({path:partial,operation:{kind:"trim",side:"both"}});
check(incomplete.includes("incomplete input"),"Completeness laundered");
await rejects(()=>tools.replace({path:incomplete,text:"BAD"}),/[Ii]ncomplete/);
for(const [path,operation] of [
 [piece,{kind:"range",startLine:1,startColumn:0,endLine:1,endColumn:8}],
 [full,{kind:"between",start:"<",end:">",extent:"inside"}],
 [full,{kind:"sliceText",from:1}],
 [full,{kind:"sliceText",from:12}],
 [full,{kind:"sliceText",from:0,to:999}],
 [full,{kind:"columns",from:0,to:2}],
 ["RESULT#forged",{kind:"trim",side:"both"}]
]) await rejects(()=>tools.select({path,operation}));
await rejects(()=>tools.write({path:piece,content:"BAD"}));
await rejects(()=>tools.undo({file:piece,change:"last"}));
const empty=await tools.select({path:[],operation:{kind:"split",delimiter:","}});
check(items(empty).length===0 && empty.includes("0 selection(s)"),"Empty scope rejected");
text({refusals:7,complete:false,empty:0});`,
    ]);
    expect(await readFile(path.join(cwd, "safe.txt"), "utf8")).toBe(source);
  });
});

test("derives an editable point from an empty file and preserves it through Read", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "empty.txt"), "");
    await runTextSelection(cwd, "text-select-empty-file", [
      `const selected=await tools.select({path:"empty.txt",operation:{kind:"position",edge:"after"}});
check(items(selected).length===1,"Empty file lost its boundary");
const read=await tools.read({path:selected});
const point=await tools.select({path:read,operation:{kind:"sliceText",from:0,to:0}});
check(items(point).length===1,"Read lost the empty file target");
text(await tools.replace({path:point,text:"NEW"}));
text({emptyFilePoint:true});`,
    ]);
    expect(await readFile(path.join(cwd, "empty.txt"), "utf8")).toBe("NEW");
  });
});

test("consumes pending writes, preserves all split items beyond preview and displays a point", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runTextSelection(cwd, "text-select-pending-preview", [
      `const written=await tools.write({path:"new.txt",content:Array.from({length:105},(_,i)=>"item"+i).join(",")});
const split=await tools.select({path:written,operation:{kind:"split",delimiter:","}});
check(items(split).length===100 && split.includes("105 selection(s)") && split.includes("more selections"),"Split target clipped");
const tail=await tools.search({path:split,query:"item104"});
check(matches(tail).length===1,"Full target lost beyond preview");
const point=await tools.select({path:tail,operation:{kind:"position",edge:"after"}});
const blank=await tools.select({path:point,operation:{kind:"split",delimiter:","}});
const boundary=items(blank)[0];
check(items(blank).length===1 && boundary.startLine===boundary.endLine && boundary.startColumn===boundary.endColumn,"Zero-width split lost");
store("textPoint",blank);
text({segments:105,shown:100,point:true});`,
      `const selected=await tools.select({path:load("textPoint"),operation:{kind:"sliceText",from:0,to:0}});
text(await tools.replace({path:selected,text:"!"}));
text({appended:true});`,
    ]);
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe(
      Array.from({ length: 105 }, (_, i) => `item${i}`).join(",") + "!",
    );
    expect(run.tuiRenderedOutput).toContain("zero-width");
  });
});
