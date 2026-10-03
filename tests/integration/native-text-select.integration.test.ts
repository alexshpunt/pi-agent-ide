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
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "select", "replace", "copy", "write", "undo", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `text-${index}`, name: "codemode", arguments: { code } })],
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
const selected=await tools.select({path:[read.data,other.data.matches[0]],operation:{kind:"between",start:"<",end:">",extent:"inside"}});
if(selected.status!=="success" || selected.data.totalItems!==3) throw Error("Sparse pairs lost");
const trimmed=await tools.select({path:selected.data.items,operation:{kind:"trim",side:"both"}});
if(trimmed.status!=="success" || trimmed.data.items[0].range.startColumn!==5) throw Error("UTF16 columns lost");
const pieces=await tools.select({path:trimmed.data,operation:{kind:"split",delimiter:","}});
if(pieces.status!=="success" || pieces.data.totalItems!==4) throw Error("Split segments lost");
const one=await tools.select({path:pieces.data.items[0],operation:{kind:"sliceText",from:0,to:3}});
store("oldTextTarget",one.data.target);
const preview=await tools.read({path:one.data.target});
const hidden=await tools.search({path:preview,query:"outside"});
if(hidden.data.matches.length!==0) throw Error("Read widened text scope");
const points=await tools.select({path:pieces.data.items[3],operation:{kind:"position",edge:"before"}});
const copied=await tools.copy({path:one,target:points});
if(copied.status!=="success" || !copied.data.target) throw Error("Point transfer failed");
const fresh=await tools.search({path:"notes.txt",query:"one"});
const changed=await tools.replace({path:fresh.data.matches.slice(0,1),text:"ONE"});
if(changed.status!=="success") throw Error("Text replacement failed");
text({pairs:3,segments:4,pointTransfer:true});`,
      `const refused=await tools.replace({path:load("oldTextTarget"),text:"BAD"});
if(refused.status!=="error" || refused.data.effect!=="not-applied") throw Error("Stale text target survived");
const source=await tools.read({path:"notes.txt"});
const selected=await tools.select({path:source,operation:{kind:"lines",first:2,last:3}});
const columns=await tools.select({path:selected,operation:{kind:"columns",from:0,to:2}});
if(columns.status!=="success" || columns.data.totalItems!==2 || columns.data.items[0].preview!=="😀") throw Error("Columns or line endings lost");
const range=await tools.select({path:source,operation:{kind:"range",startLine:2,startColumn:5,endLine:2,endColumn:8}});
if(range.status!=="success" || range.data.items[0].preview!=="ONE") throw Error("Absolute range failed");
const expanded=await tools.select({path:range,operation:{kind:"linesOf"}});
if(expanded.status!=="success" || !expanded.data.items[0].origins[0].expanded || expanded.data.items[0].range.endLine!==3 || expanded.data.items[0].range.endColumn!==0) throw Error("Line expansion wrong");
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
if(incomplete.data.complete!==false) throw Error("Completeness laundered");
const noEdit=await tools.replace({path:incomplete,text:"BAD"});
if(noEdit.status!=="error" || noEdit.data.effect!=="not-applied") throw Error("Incomplete scope editable");
for(const [path,operation] of [
 [piece,{kind:"range",startLine:1,startColumn:0,endLine:1,endColumn:8}],
 [full,{kind:"between",start:"<",end:">",extent:"inside"}],
 [full,{kind:"sliceText",from:1}],
 [full,{kind:"sliceText",from:12}],
 [full,{kind:"sliceText",from:0,to:999}],
 [full,{kind:"columns",from:0,to:2}],
 ["RESULT#forged",{kind:"trim",side:"both"}]
]){
 const refused=await tools.select({path,operation});
 if(refused.status!=="error" || refused.data?.target) throw Error("Unsafe text boundaries accepted: "+JSON.stringify(refused));
}
const write=await tools.write({path:piece,content:"BAD"});
const undo=await tools.undo({file:piece,change:"last"});
if(write.status!=="error" || undo.status!=="error" || write.data.effect!=="not-applied" || undo.data.effect!=="not-applied") throw Error("Whole-file guard widened");
const empty=await tools.select({path:[],operation:{kind:"split",delimiter:","}});
if(empty.status!=="success" || empty.data.totalItems!==0) throw Error("Empty scope rejected");
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
if(selected.status!=="success" || selected.data.totalItems!==1) throw Error("Empty file lost its boundary");
const read=await tools.read({path:selected.data.target});
const point=await tools.select({path:read,operation:{kind:"sliceText",from:0,to:0}});
if(point.status!=="success" || point.data.totalItems!==1) throw Error("Read lost the empty file target");
const changed=await tools.replace({path:point,text:"NEW"});
if(changed.status!=="success") throw Error("Empty file point could not insert");
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
if(split.status!=="success" || split.data.items.length!==100 || split.data.totalItems!==105 || !split.data.truncated || !split.data.complete) throw Error("Split target clipped");
const tail=await tools.search({path:split,query:"item104"});
if(tail.data.matches.length!==1) throw Error("Full target lost beyond preview");
const point=await tools.select({path:tail,operation:{kind:"position",edge:"after"}});
store("textPoint",point.data.target);
const blank=await tools.select({path:point,operation:{kind:"split",delimiter:","}});
if(blank.status!=="success" || blank.data.totalItems!==1 || blank.data.items[0].preview!=="") throw Error("Zero-width split lost");
text({segments:105,shown:100,point:true});`,
      `const point=load("textPoint");
const selected=await tools.select({path:point,operation:{kind:"sliceText",from:0,to:0}});
if(selected.status!=="success") throw Error("Cross-call point expired");
const changed=await tools.replace({path:selected,text:"!"});
if(changed.status!=="success") throw Error("Point insert failed");
text({appended:true});`,
    ]);
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe(
      Array.from({ length: 105 }, (_, i) => `item${i}`).join(",") + "!",
    );
    expect(run.tuiRenderedOutput).toContain("zero-width");
  });
});
