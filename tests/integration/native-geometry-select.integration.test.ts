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

async function runGeometry(cwd: string, name: string, scripts: readonly string[]) {
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
    rawMode: name !== "geometry-points-merge",
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "select", "replace", "write", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [
            toolCall({
              id: `geometry-${index}`,
              name: "codemode",
              arguments: { code: textResultChecks + code },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Geometry selection finished.")]),
    ],
  }).run("Compose verified range sets without editing the gap bytes");
  for (let index = 0; index < scripts.length; index++)
    expect(
      getToolExecution(run, `geometry-${index}`).isError,
      getToolResultText(run, `geometry-${index}`),
    ).toBe(false);
  return run;
}

test("distinguishes containment from clipping and edits difference fragments without changing gaps", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "notes.txt"),
      "outside\r\n😀 < abcKEEPxyz > gap < mnKEEPop >\r\noutside",
    );
    await writeFile(path.join(cwd, "other.txt"), "< aaKEEPbb >");
    const run = await runGeometry(cwd, "geometry-composition", [
      `const read=await tools.read({path:"notes.txt",offset:2,limit:1});
const candidates=await tools.search({path:read,query:"regex:<[^>]+>"});
const masks=await tools.search({path:read,query:"KEEP"});
const other=await tools.read({path:"other.txt"});
const kept=await tools.select({path:masks,operation:{kind:"within",scopes:candidates}});
const dropped=await tools.select({path:candidates,operation:{kind:"within",scopes:masks}});
const clipped=await tools.select({path:candidates,operation:{kind:"intersection",scopes:masks}});
if(items(kept).length!==2 || items(dropped).length!==0 || items(clipped).length!==2) throw Error("Containment confused with clipping");
const remaining=await tools.select({path:[candidates,other],operation:{kind:"difference",scopes:masks}});
if(items(remaining).length!==5 || items(remaining)[0].source.includes("other.txt")) throw Error("File sets or fragments lost");
store("geometryOld",remaining);
const preview=await tools.read({path:items(remaining)[0].ref});
const escaped=await tools.search({path:preview,query:"KEEP"});
if(matches(escaped).length!==0) throw Error("Read widened geometry");
const words=await tools.search({path:remaining,query:"regex:abc|xyz|mn|op"});
if(matches(words).length!==4) throw Error("Fragments lost");
text(await tools.replace({path:words,text:"*"}));`,
      `await rejects(()=>tools.select({path:load("geometryOld"),operation:{kind:"merge"}}),/expired|stale/);
const fresh=await tools.select({path:"other.txt",operation:{kind:"difference",scopes:[]}});
if(!fresh.endsWith("< aaKEEPbb >")) throw Error("Empty mask changed candidate");
text({staleRejected:true,emptyMask:true});`,
    ]);
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(
      "outside\r\n😀 < *KEEP* > gap < *KEEP* >\r\noutside",
    );
    expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("< aaKEEPbb >");
    expect(getToolResultText(run, "geometry-0")).toContain("*KEEP*");
  });
});

test("merges pending source ranges with explicit adjacency and preserves boundary points across calls", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runGeometry(cwd, "geometry-points-merge", [
      `const written=await tools.write({path:"new.txt",content:"0123456789abcdef"});
const slice=async(from,to)=>await tools.select({path:written,operation:{kind:"sliceText",from,to}});
const ranges=await Promise.all([[0,3],[2,5],[5,7],[10,12]].map(([from,to])=>slice(from,to)));
const overlap=await tools.select({path:ranges,operation:{kind:"merge"}});
const adjacent=await tools.select({path:ranges,operation:{kind:"merge",adjacent:true}});
if(items(overlap).length!==3 || items(adjacent).length!==2 || !adjacent.includes("0123456")) throw Error("Merge policy lost");
const left=await slice(0,3), right=await slice(3,7), point=await slice(3,3), eof=await slice(16,16);
const touch=await tools.select({path:left,operation:{kind:"intersection",scopes:right}});
const excluded=await tools.select({path:point,operation:{kind:"within",scopes:left}});
const included=await tools.select({path:right,operation:{kind:"intersection",scopes:point}});
const unchanged=await tools.select({path:right,operation:{kind:"difference",scopes:point}});
const removePoint=await tools.select({path:point,operation:{kind:"difference",scopes:right}});
const eofOutside=await tools.select({path:eof,operation:{kind:"within",scopes:written}});
const points=await tools.select({path:[left,point,eof],operation:{kind:"merge",adjacent:true}});
if(items(touch).length || items(excluded).length || items(removePoint).length || items(eofOutside).length || items(included).length!==1 || !unchanged.endsWith("3456") || items(points).length!==3) throw Error("Point semantics lost");
store("geometryPoint",included);
text({overlap:3,adjacent:2,points:3});`,
      `const selected=await tools.select({path:load("geometryPoint"),operation:{kind:"merge"}});
if(items(selected)[0].startColumn!==3) throw Error("Cross-call point expired");
text(await tools.replace({path:selected,text:"!"}));`,
    ]);
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("012!3456789abcdef");
    expect(run.tuiRenderedOutput).toContain("zero-width");
  });
});

test("retains all geometry beyond previews and refuses unsafe right inputs even without a matching file", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "many.txt"),
      Array.from({ length: 105 }, (_, i) => `v${i}`).join("|"),
    );
    await writeFile(path.join(cwd, "limited.js"), "first(); second();");
    await writeFile(path.join(cwd, "scope.txt"), "safe");
    await runGeometry(cwd, "geometry-completeness-refusals", [
      `const source=await tools.read({path:"many.txt"});
const split=await tools.select({path:source,operation:{kind:"split",delimiter:"|"}});
const kept=await tools.select({path:split,operation:{kind:"difference",scopes:[]}});
const tail=await tools.search({path:kept,query:"v104"});
if(!kept.includes("105 selection(s)") || items(kept).length!==100 || !kept.includes("more selections") || kept.includes("incomplete") || matches(tail).length!==1) throw Error("Geometry preview clipped authority");
const partial=await tools.search({path:"limited.js",query:"ast:$NAME()",limit:1});
const incomplete=await tools.select({path:source,operation:{kind:"difference",scopes:partial}});
check(incomplete.includes("incomplete input"),"Right completeness laundered");
await rejects(()=>tools.replace({path:incomplete,text:"BAD"}),/[Ii]ncomplete/);
for(const scopes of ["RESULT#forged",{kind:"diff"}]) {
 await rejects(()=>tools.select({path:[],operation:{kind:"difference",scopes}}));
}
const old=await tools.read({path:"scope.txt"}); store("oldScope",old);
text(await tools.replace({path:old,text:"changed"}));`,
      `await rejects(()=>tools.select({path:"many.txt",operation:{kind:"intersection",scopes:load("oldScope")}}),/expired|stale/);
const empty=await tools.select({path:[],operation:{kind:"within",scopes:"many.txt"}});
if(items(empty).length!==0) throw Error("Empty candidate widened");
text({staleRightRejected:true,empty:true});`,
    ]);
    expect(await readFile(path.join(cwd, "many.txt"), "utf8")).toBe(
      Array.from({ length: 105 }, (_, i) => `v${i}`).join("|"),
    );
  });
});

test("ordinary Select accepts readable comparison scopes without Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "ordinary.txt"), "safe\r\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    const run = await new PiIntegrationTest({
      testName: "geometry-ordinary",
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
                path: "ordinary.txt",
                operation: { kind: "within", scopes: "ordinary.txt" },
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Ordinary selection finished.")]),
      ],
    }).run("Keep this verified file within itself");
    expect(getToolExecution(run, "ordinary").isError, getToolResultText(run, "ordinary")).toBe(
      false,
    );
    expect(getToolResultText(run, "ordinary")).toContain("1 selection(s)");
    expect(run.tuiRenderedOutput).toContain("1 selection in 1 file");
    expect(await readFile(path.join(cwd, "ordinary.txt"), "utf8")).toBe("safe\r\n");
  });
});
