import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

async function runText(cwd: string, name: string, scripts: string[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: [
      "read",
      "search",
      "select",
      "replace",
      "write",
      "insert",
      "delete",
      "copy",
      "move",
      "undo",
      "bash",
      "codemode",
    ],
    conversation: [
      ...scripts.map((code, i) =>
        assistantMessage([toolCall({ id: `script-${i}`, name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Compose readable tool results without inspecting internal objects");
}

test("view warnings stay outside source selections and remain visible in native panels", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(
      path.join(cwd, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const run = await runText(cwd, "requested-view-warnings", [
      String.raw`
const warning = await tools.read({path:"note.txt",views:["anchors","ghost"]});
if(typeof warning !== "string" || !warning.includes("Unknown view ignored: ghost. Remove it or choose a supported view from the views parameter.")) throw new Error(warning);
const outside = await tools.search({path:warning,query:"regex:Unknown view|supported view|Remove it"});
if(!outside.includes("No matches found")) throw new Error(outside);
store("readViewWarning",warning);
const image = await tools.read({path:"pixel.png",views:["anchors"]});
if(!image.includes("View not applied: anchors requires text. Read a text source to use anchors.")) throw new Error(image);
text("View warnings verified");
`,
      String.raw`
const saved = load("readViewWarning");
const beta = await tools.search({path:saved,query:"beta"});
await tools.replace({path:beta,text:"BETA"});
const unknown = await tools.read({path:"pixel.png",views:["ghost"]});
if(!unknown.includes("Unknown view ignored: ghost.")) throw new Error(unknown);
text("Unknown image view preserved");
`,
      String.raw`
const valid = await tools.read({path:"pixel.png",views:["image"]});
if(valid.includes("View not applied") || valid.includes("Unknown view")) throw new Error(valid);
text("Native image view remains valid");
`,
      `await tools.read({path:"note.txt",views:["ghost"]});
await tools.read({path:"pixel.png",views:["anchors"]});`,
    ]);
    for (const id of ["script-0", "script-1", "script-2", "script-3"]) {
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      expect(
        getToolResultMessage(run, id).content.filter((block) => block.type === "image"),
      ).toEqual([
        {
          type: "image",
          data: (await readFile(path.join(cwd, "pixel.png"))).toString("base64"),
          mimeType: "image/png",
        },
      ]);
    }
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(run.tuiRenderedOutput).toContain("Unknown view ignored: ghost.");
    expect(run.tuiRenderedOutput).toContain("anchors requires text.");
    expect(run.tuiRenderedOutput).toContain("Read a text source to use anchors.");
  });
});
test("oversized Read lines offer recovery for original bytes and transformed jq values", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "é".repeat(30000) + "\nlast\n";
    const json = JSON.stringify({ payload: "y".repeat(60000) }) + "\n";
    await writeFile(path.join(cwd, "long.txt"), source);
    await writeFile(path.join(cwd, "values.txt"), json);
    const run = await runText(cwd, "oversized-line-recovery", [
      String.raw`
const capped = await tools.read({path:"long.txt",views:["anchors"]});
if(typeof capped !== "string" || !capped.includes("This line was not returned.")) throw new Error(capped);
const action = /Read ("(?:[^"\\]|\\.)*") with offset=(\d+) and limit=(\d+) to inspect the original bytes/u.exec(capped);
if(action === null) throw new Error("No bounded raw recovery: " + capped);
const raw = await tools.read({path:JSON.parse(action[1]),offset:Number(action[2]),limit:Number(action[3])});
if(!raw.includes("Bytes 0..4096 (end exclusive), 60006 bytes total") || raw.includes("Output limited")) throw new Error(raw);
const nextLine = await tools.read({path:"long.txt",offset:2});
if(!nextLine.endsWith("last\n")) throw new Error(nextLine);
const transformed = await tools.read({path:"values.txt",views:["jq:.payload"]});
if(!transformed.includes("Output line 1") || !transformed.includes("Narrow the jq filter to return a smaller value.") || transformed.includes("raw:")) throw new Error(transformed);
const saved = /Full output: (temp:[^. ]+)/u.exec(transformed);
if(saved === null) throw new Error("Full jq output reference lost");
store("oversizedJqOutput",saved[1]);
store("oversizedJqSource","values.txt");
const smaller = await tools.read({path:"values.txt",views:["jq:.payload[0:64]"]});
if(!smaller.endsWith(JSON.stringify("y".repeat(64)) + "\n")) throw new Error(smaller);
text(capped); text(transformed); text(smaller);
`,
      String.raw`
const saved = await tools.read({path:load("oversizedJqOutput")});
if(!saved.includes("58.6KB") || !saved.includes("source-specific tool")) throw new Error("Full saved output was not retained: " + saved);
const smaller = await tools.read({path:load("oversizedJqSource"),views:["jq:.payload[0:64]"]});
if(!smaller.endsWith(JSON.stringify("y".repeat(64)) + "\n")) throw new Error(smaller);
text(smaller);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "long.txt"), "utf8")).toBe(source);
    expect(await readFile(path.join(cwd, "values.txt"), "utf8")).toBe(json);
  });
});
test("whole-file Copy and Move replace existing destinations and retire their old results", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "source.txt"), "fresh\n");
    await writeFile(path.join(cwd, "copied.txt"), "old copy\n");
    await writeFile(path.join(cwd, "moved.txt"), "old move\n");
    const run = await runText(cwd, "whole-file-transfer-replaces-target", [
      `
const oldCopy = await tools.read({path:"copied.txt"});
const oldMove = await tools.read({path:"moved.txt"});
const copied = await tools.copy({path:"source.txt",target:"copied.txt"});
if (!(await tools.read({path:copied})).endsWith("fresh\\n")) throw Error("Copy did not replace the destination");
const moved = await tools.move({path:copied,target:"moved.txt"});
text(await tools.read({path:moved}));
for (const old of [oldCopy,oldMove]) {
  let rejected = false;
  try { await tools.read({path:old}); }
  catch (error) { rejected = /expired|unknown/.test(String(error)); }
  if (!rejected) throw Error("Old destination result survived replacement");
}
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("fresh\n");
    expect(await readFile(path.join(cwd, "moved.txt"), "utf8")).toBe("fresh\n");
    await expect(readFile(path.join(cwd, "copied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
test("Codemode prints file text and composes Read, Search, Select and pending mutations", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runText(cwd, "text-result-chain", [
      `
const shown = await tools.read({path:"note.txt"});
if (typeof shown !== "string" || !shown.endsWith("alpha\\nbeta\\ngamma\\n")) throw Error("Read did not return file text");
text(shown);
const found = await tools.search({path:shown, query:"beta"});
const selected = await tools.select({path:found, operation:{kind:"trim",side:"both"}});
const accepted = await tools.replace({path:selected, text:"BETA"});
const after = await tools.read({path:accepted});
if (!after.includes("BETA")) throw Error("Pending mutation did not compose");
return after;
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(getToolResultText(run, "script-0")).not.toContain('"kind":"text"');
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });
});

test("empty Read notices stay outside composable source selections", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "empty.txt"), "");
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runText(cwd, "empty-read-notices", [
      String.raw`
const empty = await tools.read({path:"empty.txt"});
const zero = await tools.read({path:"note.txt",limit:0});
const pastEnd = await tools.read({path:"note.txt",offset:10});
for (const [result, notice] of [
  [empty, "[Empty source.]"],
  [zero, "[No lines selected: limit=0.]"],
  [pastEnd, "[Offset 10 is beyond the end of the source (3 lines).]"],
]) {
  if (typeof result !== "string" || !result.endsWith(notice)) throw Error("Missing empty-read explanation: "+result);
  text(result);
  const found = await tools.search({path:result,query:"regex:Empty|No lines|Offset|alpha"});
  if (!found.includes("No matches found")) throw Error("Empty selection searched a notice or neighboring text: "+found);
}
await tools.replace({path:zero,text:"BAD"});
await tools.flush({});
store("emptyWindow",pastEnd);
`,
      String.raw`
const saved = load("emptyWindow");
const found = await tools.search({path:saved,query:"alpha"});
if (!found.includes("No matches found")) throw Error("Stored empty selection widened to the source");
let emptyReadRejected = false;
try { await tools.read({path:saved}); } catch (error) { emptyReadRejected = String(error).includes("Empty result target set"); }
if (!emptyReadRejected) throw Error("Read widened an empty target set");
let failed = false;
try { await tools.read({path:"missing.txt"}); } catch { failed = true; }
if (!failed) throw Error("Missing source became an empty success");
text(found);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "empty.txt"), "utf8")).toBe("");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });
});
test("Read continuation names an executable source without widening result selections", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(
      path.join(cwd, "items.json"),
      JSON.stringify({ items: ["alpha", "beta", "gamma"] }),
    );
    const run = await runText(cwd, "read-window-continuation", [
      String.raw`
async function follow(result, remaining, expected) {
  const action = /\[(\d+) more (?:line|lines) in source\. Read ("(?:[^"\\]|\\.)*") with offset=(\d+)(?: and views=(\[[^\n]*\]))? to continue\.\]$/.exec(result);
  if (!action || Number(action[1]) !== remaining) throw Error("Missing executable continuation: "+result);
  const next = await tools.read({path:JSON.parse(action[2]),offset:Number(action[3]),...(action[4] ? {views:JSON.parse(action[4])} : {})});
  if (!next.endsWith(expected)) throw Error("Continuation used the wrong coordinate frame: "+next);
  text(result); text(next);
}
const transformed = await tools.read({path:"items.json",views:["jq:.items[]"],limit:1});
await follow(transformed,2,'"beta"\n"gamma"\n');
const window = await tools.read({path:"note.txt",limit:2});
await follow(window,1,"gamma\n");
const narrower = await tools.read({path:window,limit:1});
await follow(narrower,2,"beta\ngamma\n");
const ordinary = await tools.read({path:window});
if (!ordinary.endsWith("alpha\nbeta")) throw Error("Default selection read gained an unsolicited notice: "+ordinary);
const anchored = await tools.read({path:"note.txt#beta",limit:1});
await follow(anchored,1,"gamma\n");
for (const [result, query] of [
  [window,"regex:gamma|more line|offset="],
  [narrower,"regex:beta|gamma|more line|offset="],
  [await tools.read({path:window,offset:3}),"gamma"],
]) {
  const found = await tools.search({path:result,query});
  if (!found.includes("No matches found")) throw Error("Context or notice widened source authority: "+found);
}
const zero = await tools.read({path:window,limit:0});
if (!zero.endsWith("[No lines selected: limit=0.]")) throw Error("Empty result received continuation instead of its reason: "+zero);
store("window",narrower);
`,
      String.raw`
const found = await tools.search({path:load("window"),query:"beta"});
if (!found.includes("No matches found")) throw Error("Stored narrowed result widened");
text(found);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });
});
test("unmapped Read caps keep both sources available for a smaller retry", async () => {
  await withTempWorkspace(async (cwd) => {
    const fixtures = [
      { prefix: "line", rows: 1100, width: 0 },
      { prefix: "byte", rows: 35, width: 1000 },
    ].flatMap(({ prefix, rows, width }) =>
      ["left", "right"].map((side) => ({
        name: `${prefix}-${side}.txt`,
        content: Array.from(
          { length: rows },
          (_, index) => `${side} ${index + 1} ${"x".repeat(width)}\n`,
        ).join(""),
      })),
    );
    await Promise.all(
      fixtures.map(({ name, content }) => writeFile(path.join(cwd, name), content)),
    );
    const run = await runText(cwd, "unmapped-read-cap-recovery", [
      String.raw`
for (const prefix of ["line", "byte"]) {
  const originals = await Promise.all(["left", "right"].map(side => tools.read({path:prefix+"-"+side+".txt"})));
  const selection = await tools.select({path:originals,operation:{kind:"merge"}});
  const capped = await tools.read({path:selection,views:["anchors"]});
  if (typeof capped !== "string") throw Error("Read did not return text");
  const notice = capped.split("\n").find(line => line.startsWith("[Output truncated:"));
  if (!notice || !notice.includes("No single source-line continuation is available.") ||
      !notice.includes("Retry Read with a smaller limit, keeping the same source and views."))
    throw Error("Missing actionable unmapped-cap explanation: "+notice);
  if (/offset=\d+/.test(notice)) throw Error("Invented a source continuation offset");
  text(notice);
  const retry = await tools.read({path:capped,limit:10,views:["anchors"]});
  for (const side of ["left","right"])
    if (!retry.includes("|"+side+" 10 ")) throw Error("Recovery lost source or anchor view: "+side);
  if (retry.includes("Output truncated:")) throw Error("Smaller retry remained capped");
  const outside = await tools.search({path:retry,query:"regex:left 11|right 11|Output truncated"});
  if (!outside.includes("No matches found")) throw Error("Recovery widened its ten-line windows");
  store(prefix+"-cap", capped);
}
`,
      String.raw`
for (const prefix of ["line", "byte"]) {
  const capped = load(prefix+"-cap");
  const retry = await tools.read({path:capped,limit:10,views:["anchors"]});
  if (!retry.includes("|left 10 ") || !retry.includes("|right 10 "))
    throw Error("Stored cap result lost a source or requested view");
}
text("Stored results keep both source windows for recovery.");
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    for (const { name, content } of fixtures)
      expect(await readFile(path.join(cwd, name), "utf8")).toBe(content);
  });
});
test("automatic Read caps give executable text, view and byte continuations", async () => {
  await withTempWorkspace(async (cwd) => {
    const lines = Array.from({ length: 2105 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await writeFile(path.join(cwd, "lines.txt"), lines);
    await writeFile(path.join(cwd, "counts.txt"), '{"count":2105}\n');
    await writeFile(
      path.join(cwd, "bytes.txt"),
      Array.from({ length: 60 }, (_, i) => `row ${i + 1} ${"x".repeat(1000)}`).join("\n") + "\n",
    );
    const run = await runText(cwd, "automatic-read-continuation", [
      String.raw`
async function followText(result, nextLine, expectedPrefix, views) {
  const action = /\[Showing lines \d+-\d+ of \d+ \((?:\d+-line|[\d.]+KB) limit\)\. Read ("(?:[^"\\]|\\.)*") with offset=(\d+)(?: and views=(\[[^\n]*\]))? to continue\./.exec(result);
  if (!action || Number(action[2]) !== nextLine) throw Error("Missing automatic-cap action: "+result.slice(-600));
  const requestedViews = action[3] ? JSON.parse(action[3]) : undefined;
  if (JSON.stringify(requestedViews) !== JSON.stringify(views)) throw Error("Continuation lost views");
  const next = await tools.read({path:JSON.parse(action[1]),offset:Number(action[2]),...(requestedViews ? {views:requestedViews} : {})});
  if (!next.split("\n").slice(1).join("\n").startsWith(expectedPrefix)) throw Error("Wrong continuation: "+next.slice(0,600));
  text(result.split("\n").find(line=>line.startsWith("[Showing lines")));
}
const limited = await tools.read({path:"lines.txt",limit:2010});
await followText(limited,2001,"row 2001\n");
const anchors = await tools.read({path:"lines.txt",limit:5,views:["anchors"]});
const anchor = /\b(5#[A-Fa-f0-9]+)\|row 5/.exec(anchors)?.[1];
if (!anchor) throw Error("No current line-5 anchor");
await followText(await tools.read({path:"lines.txt#"+anchor}),2005,"row 2005\n");
await followText(await tools.read({path:"bytes.txt"}),51,"row 51 ");
await followText(await tools.read({path:"counts.txt",views:["jq:range(1; .count + 1)"]}),2001,"2001\n",["jq:range(1; .count + 1)"]);
const context = await tools.read({path:limited,offset:2001});
const outside = await tools.search({path:context,query:"regex:row 2011|Showing lines|offset="});
if (!outside.includes("No matches found")) throw Error("Cap or continuation widened the requested selection");
const inside = await tools.search({path:context,query:"regex:row 2010$"});
if (!inside.includes("row 2010")) throw Error("Valid continuation selection was lost");
const raw = await tools.read({path:"raw:bytes.txt"});
const action = /\[Output limited\. Read ("(?:[^"\\]|\\.)*") with offset=(\d+) to continue\.\]$/.exec(raw);
if (!action) throw Error("Missing raw output-limit explanation");
const after = await tools.read({path:JSON.parse(action[1]),offset:Number(action[2]),limit:16});
const range = /Bytes (\d+)[.][.](\d+)/.exec(after);
if (!range || Number(range[1]) !== Number(action[2]) || Number(range[2]) !== Number(action[2])+16 || after.includes("Output limited")) throw Error("Raw continuation or explicit-window behavior changed");
text(raw.split("\n").at(-1));
store("limited",limited);
`,
      String.raw`
const found = await tools.search({path:load("limited"),query:"regex:row 2011$"});
if (!found.includes("No matches found")) throw Error("Stored cap widened the requested range");
text(found);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "lines.txt"), "utf8")).toBe(lines);
  });
});
test("pending result strings confirm at dependent boundaries without invalidating batch peers", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await runText(cwd, "pending-text-result-peers", [
      `
const first=await tools.replace({path:"note.txt",start:"alpha",text:"ALPHA"});
const second=await tools.replace({path:"note.txt",start:"beta",text:"BETA"});
if(!first.includes("not yet applied")||!second.includes("not yet applied")) throw Error("Original-snapshot edits wrote early");
const shown=await tools.read({path:first});
const found=await tools.search({path:second,query:"BETA"});
if(!shown.includes("ALPHA")||!found.includes("BETA")) throw Error("A peer result expired at the common commit");
text(shown); text(found);
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });
});
test("store/load retains text and UUID composition until the file snapshot changes", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await runText(cwd, "text-result-store", [
      `store("source", await tools.read({path:"note.txt"}));`,
      `const source=load("source"); const uuid=/<uuid>([^<]+)<\\/uuid>/.exec(source)[1]; const found=await tools.search({path:uuid,query:"beta"}); text(await tools.replace({path:found,text:"BETA"}));`,
      `let rejected=false; try { await tools.search({path:load("source"),query:"alpha"}); } catch(error) { rejected=String(error).includes("expired"); } if(!rejected) throw Error("Stored old result survived a write"); text("Old result rejected");`,
    ]);
    for (let i = 0; i < 3; i++)
      expect(
        getToolExecution(run, `script-${i}`).isError,
        getToolResultText(run, `script-${i}`),
      ).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\n");
  });
});

test("explicit-text errors require a current anchor, then allow explicit text again", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runText(cwd, "text-result-anchor-recovery", [
      `
let failed=""; try { await tools.replace({path:"note.txt",start:"betx",text:"BETA"}); } catch(error) { failed=String(error); }
if(!failed.includes("anchor")) throw Error("Missing recovery anchors");
let blocked=""; try { await tools.replace({path:"note.txt",start:"beta",text:"BETA"}); } catch(error) { blocked=String(error); }
if(!blocked.includes("blocked")) throw Error("Explicit text retried without an anchor");
await tools.write({path:"note.txt",content:"ALPHA\\nbeta\\ngamma\\n"});
let stillBlocked=""; try { await tools.replace({path:"note.txt",start:"beta",text:"BETA"}); } catch(error) { stillBlocked=String(error); }
if(!stillBlocked.includes("blocked")) throw Error("An unanchored write bypassed recovery");
const current=await tools.read({path:"note.txt",views:["anchors"]});
const anchor=/(\\d+#[A-Fa-f0-9]+)[^\\n]*beta/.exec(current)?.[1];
if(!anchor) throw Error("Read did not show beta's anchor: "+current);
await tools.replace({path:"note.txt",start:anchor,text:"BETA"});
await tools.replace({path:"note.txt",start:"gamma",text:"GAMMA"});
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nBETA\nGAMMA\n");
  });
});

test("direct tools accept unchanged results and UUIDs without Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await new PiIntegrationTest({
      testName: "direct-text-result-forwarding",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("tests/integration/fixtures/forward-text-result.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["read", "search", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "read-source", name: "read", arguments: { path: "note.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "search-result",
              name: "search",
              arguments: { path: "$previous-result", query: "beta" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "edit-uuid",
              name: "replace",
              arguments: { path: "$previous-uuid", text: "BETA" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Forward the readable result and then its UUID through direct tools");
    for (const id of ["read-source", "search-result", "edit-uuid"]) {
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      expect(getToolResultText(run, id)).toMatch(/^<system-result/u);
    }
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\n");
  });
});
test("a registered Search selection restores exact-text editing after a selector failure", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runText(cwd, "text-result-search-recovery", [
      String.raw`
let failed=false; try { await tools.replace({path:"note.txt",start:"missing",text:"BAD"}); } catch { failed=true; }
if(!failed) throw Error("Expected exact-text failure");
const found=await tools.search({path:"note.txt",query:"beta"});
await tools.replace({path:found,text:"BETA"});
await tools.replace({path:"note.txt",start:"gamma",text:"GAMMA"});
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\nGAMMA\n");
  });
});

test.runIf(process.platform !== "win32")(
  "live terminal results compose through IDs without granting filesystem authority",
  async () => {
    await withTempWorkspace(async (cwd) => {
      const run = await runText(cwd, "text-result-live-shell", [
        String.raw`
const started=await tools.bash({command:"IFS= read -r answer; printf 'resource:%s' \"$answer\"",background:true});
const uuid=/<uuid>([^<]+)<\/uuid>/.exec(started)?.[1];
if(!uuid) throw Error("Missing shell result ID");
await tools.write({path:uuid,content:"hello"});
await tools.insert({path:started,text:"Enter"});
const shown=await tools.read({path:started});
if(!shown.includes("resource:hello")) throw Error("Shell output lost: "+shown);
let rejected=false; try { await tools.replace({path:shown,start:"hello",text:"BAD"}); } catch { rejected=true; }
if(!rejected) throw Error("Shell output granted text-edit authority");
text(await tools.delete({path:shown}));
`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      expect(getToolResultText(run, "script-0")).toContain("Deleted terminal session");
    });
  },
);
test("system envelopes cannot be inserted into file contents", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const run = await runText(cwd, "text-result-payload-guard", [
      `
const shown=await tools.read({path:"note.txt"});
let rejected=false; try { await tools.write({path:"copy.txt",content:shown}); } catch(error) { rejected=String(error).includes("system result"); }
if(!rejected) throw Error("A system envelope was written to a file");
text("System marker rejected");
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    await expect(readFile(path.join(cwd, "copy.txt"), "utf8")).rejects.toThrow("ENOENT");
  });
});
