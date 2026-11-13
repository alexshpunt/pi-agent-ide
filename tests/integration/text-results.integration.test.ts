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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

/** Each failed IDE call of a Codemode result: its tool and source line, then its reason. */
function failedCalls(output: string): string[] {
  // Guides that a call delivers on first use follow the block; they are not failures.
  const [block = ""] = codemodeFailures(output).split("\n\n---\n\n# Guide:");
  return block.split("\n- ").slice(1);
}

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
// The warning reaches the model through the Codemode result and the panel, not the value.
if(typeof warning?.text !== "string" || warning.text.includes("ghost") || !warning.text.includes("|beta")) throw new Error(JSON.stringify(warning));
const outside = await tools.search({path:warning,query:"ghost"});
if(outside.matches.length !== 0) throw new Error(JSON.stringify(outside));
store("readViewWarning",warning);
const image = await tools.read({path:"pixel.png",views:["anchors"]});
if(image?.type !== "image" || "note" in image) throw new Error(JSON.stringify(image).slice(0, 300));
text("View warnings verified");
`,
      String.raw`
const saved = load("readViewWarning");
const beta = await tools.search({path:saved,query:"beta"});
await tools.replace({path:beta,text:"BETA"});
const unknown = await tools.read({path:"pixel.png",views:["ghost"]});
if(unknown?.type !== "image" || "note" in unknown) throw new Error(JSON.stringify(unknown).slice(0, 300));
text("Unknown image view preserved");
`,
      String.raw`
const valid = await tools.read({path:"pixel.png"});
if(valid?.type !== "image" || "note" in valid) throw new Error(JSON.stringify(valid).slice(0, 300));
text("Native image read stays free of view warnings");
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
  });
});

test("requested-view warnings are shown in the native read panels", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(
      path.join(cwd, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    // An image result fills most of the 50-row test screen, so each panel gets its own run.
    const textRun = await runText(cwd, "requested-view-warning-text-panel", [
      `await tools.read({path:"note.txt",views:["ghost"]});`,
    ]);
    expect(
      getToolExecution(textRun, "script-0").isError,
      getToolResultText(textRun, "script-0"),
    ).toBe(false);
    expect(textRun.tuiRenderedOutput).toContain("ghost");
    const imageRun = await runText(cwd, "requested-view-warning-image-panel", [
      `await tools.read({path:"pixel.png",views:["anchors"]});`,
    ]);
    expect(
      getToolExecution(imageRun, "script-0").isError,
      getToolResultText(imageRun, "script-0"),
    ).toBe(false);
    expect(imageRun.tuiRenderedOutput).toContain("anchors");
  });
});
test("scripts read oversized lines and jq values whole while raw bytes stay bounded", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "é".repeat(30000) + "\nlast\n";
    const json = JSON.stringify({ payload: "y".repeat(60000) }) + "\n";
    await writeFile(path.join(cwd, "long.txt"), source);
    await writeFile(path.join(cwd, "values.txt"), json);
    const run = await runText(cwd, "oversized-line-recovery", [
      String.raw`
const strip = (value) => value.text;
const whole = strip(await tools.read({path:"long.txt"}));
if(whole !== "é".repeat(30000) + "\nlast\n") throw new Error("Expected the whole oversized line: " + whole.slice(-200));
// Every requested byte reaches the script: 4096 bytes are 5464 base64 characters.
const raw = await tools.read({path:"raw:long.txt",offset:0,limit:4096});
if(raw?.bytes.length !== 5464) throw new Error(JSON.stringify(raw).slice(0, 200));
const nextLine = await tools.read({path:"long.txt",offset:2});
if(nextLine.text !== "last\n") throw new Error(nextLine.text);
const transformed = strip(await tools.read({path:"values.txt",views:["jq:.payload"]}));
if(transformed !== JSON.stringify("y".repeat(60000)) + "\n") throw new Error("Expected the whole jq value: " + transformed.slice(-200));
const smaller = await tools.read({path:"values.txt",views:["jq:.payload[0:64]"]});
if(smaller.text !== JSON.stringify("y".repeat(64)) + "\n") throw new Error(smaller.text);
text(JSON.stringify({ line: whole.length, value: transformed.length }));
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
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
if ((await tools.read({path:copied})).text !== "fresh\\n") throw Error("Copy did not replace the destination");
const moved = await tools.move({path:copied,target:"moved.txt"});
text((await tools.read({path:moved})).text);
// A retired result is refused; the Codemode result lists the reason of each refusal.
for (const old of [oldCopy,oldMove])
  if ((await tools.read({path:old})) !== null) throw Error("Old destination result survived replacement");
`,
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError, output).toBe(false);
    const refusals = failedCalls(output);
    expect(refusals, output).toHaveLength(2);
    for (const refusal of refusals)
      expect(refusal).toMatch(/^read RESULT#[\s\S]*(?:expired|unknown)/u);
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("fresh\n");
    expect(await readFile(path.join(cwd, "moved.txt"), "utf8")).toBe("fresh\n");
    await expect(readFile(path.join(cwd, "copied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
test("Codemode prints file text and composes Read, Search and pending mutations", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runText(cwd, "text-result-chain", [
      `
const shown = await tools.read({path:"note.txt"});
if (shown?.text !== "alpha\\nbeta\\ngamma\\n") throw Error("Read did not return file text");
text(shown.text);
const found = await tools.search({path:shown, query:"beta"});
const accepted = await tools.replace({path:found, text:"BETA"});
const after = await tools.read({path:accepted});
if (!after.text.includes("BETA")) throw Error("Pending mutation did not compose");
return after.text;
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
// The empty-read notices reach the model through the Codemode result, not the values.
for (const result of [empty, zero, pastEnd]) {
  if (result?.text !== "") throw Error("Empty read returned text: "+JSON.stringify(result));
  const found = await tools.search({path:result,query:"regex:Empty|No lines|Offset|alpha"});
  if (found.matches.length !== 0) throw Error("Empty selection searched a notice or neighboring text: "+JSON.stringify(found));
}
await tools.replace({path:zero,text:"BAD"});
store("emptyWindow",pastEnd);
`,
      String.raw`
const saved = load("emptyWindow");
const found = await tools.search({path:saved,query:"alpha"});
if (found.matches.length !== 0) throw Error("Stored empty selection widened to the source");
const emptyRead = await tools.read({path:saved});
if (emptyRead !== null) throw Error("Read widened an empty target set");
const failed = await tools.read({path:"missing.txt"});
if (failed !== null) throw Error("Missing source became an empty success");
text(found);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const [emptyRead, missing, ...others] = failedCalls(getToolResultText(run, "script-1"));
    expect(others).toEqual([]);
    expect(emptyRead).toMatch(/^read RESULT#/u);
    expect(missing).toMatch(/^read missing\.txt\n/u);
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
// A value holds exactly its window; a script continues with its own offset.
function exact(result, expected) {
  if (result?.text !== expected) throw Error("Expected " + JSON.stringify(expected) + ", got " + JSON.stringify(result));
  text(result.text);
}
const transformed = await tools.read({path:"items.json",views:["jq:.items[]"],limit:1});
exact(transformed,'"alpha"\n');
exact(await tools.read({path:"items.json",views:["jq:.items[]"],offset:2}),'"beta"\n"gamma"\n');
const window = await tools.read({path:"note.txt",limit:2});
exact(window,"alpha\nbeta\n");
exact(await tools.read({path:"note.txt",offset:3}),"gamma\n");
const narrower = await tools.read({path:window,limit:1});
exact(narrower,"alpha\n");
const ordinary = await tools.read({path:window});
exact(ordinary,"alpha\nbeta\n");
const anchored = await tools.read({path:"note.txt#beta",limit:1});
exact(anchored,"beta\n");
for (const [result, query] of [
  [window,"regex:gamma|more line|offset="],
  [narrower,"regex:beta|gamma|more line|offset="],
  [await tools.read({path:window,offset:3}),"gamma"],
]) {
  const found = await tools.search({path:result,query});
  if (found.matches.length !== 0) throw Error("Context or notice widened source authority: "+JSON.stringify(found));
}
const zero = await tools.read({path:window,limit:0});
exact(zero,"");
store("window",narrower);
`,
      String.raw`
const found = await tools.search({path:load("window"),query:"beta"});
if (found.matches.length !== 0) throw Error("Stored narrowed result widened");
text(found);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });
});

test("scripts read whole windows with explicit-limit continuations and bounded raw bytes", async () => {
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
const strip = (value) => value.text;
const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => "row " + (from + i)).join("\n");
// The value holds the whole requested window and no continuation notice.
const limited = await tools.read({path:"lines.txt",limit:2010});
if (strip(limited) !== rows(1, 2010) + "\n") throw Error("Expected the whole requested window: " + strip(limited).slice(-600));
const next = strip(await tools.read({path:"lines.txt",offset:2011}));
if (next !== rows(2011, 2105) + "\n") throw Error("Wrong continuation: " + next.slice(0, 600));
const anchors = await tools.read({path:"lines.txt",limit:5,views:["anchors"]});
const anchor = /^\s*([0-9A-HJKMNP-TV-Z]{7})\|row 5$/m.exec(strip(anchors))?.[1];
if (!anchor) throw Error("No current line-5 anchor");
const anchored = strip(await tools.read({path:"lines.txt#"+anchor}));
if (anchored !== rows(5, 2105) + "\n") throw Error("Expected the whole anchored remainder");
const heavy = Array.from({ length: 60 }, (_, i) => "row " + (i + 1) + " " + "x".repeat(1000)).join("\n") + "\n";
if (strip(await tools.read({path:"bytes.txt"})) !== heavy) throw Error("Expected every byte-heavy row");
const counted = strip(await tools.read({path:"counts.txt",views:["jq:range(1; .count + 1)"]}));
if (counted !== Array.from({ length: 2105 }, (_, i) => String(i + 1)).join("\n") + "\n") throw Error("Expected every jq output line");
const context = await tools.read({path:limited,offset:2001});
const outside = await tools.search({path:context,query:"regex:row 2011|Showing lines|offset="});
if (outside.matches.length !== 0) throw Error("Cap or continuation widened the requested selection");
const inside = await tools.search({path:context,query:"regex:row 2010$"});
if (inside.matches.length !== 1 || inside.matches[0].text !== "row 2010" || inside.matches[0].line !== 2010) throw Error("Valid continuation selection was lost");
// A script gets every requested byte; only the readable hex view is bounded.
const raw = await tools.read({path:"raw:bytes.txt"});
if (raw?.bytes.length !== 4 * Math.ceil(heavy.length / 3)) throw Error("Raw bytes were cut: " + raw?.bytes.length);
const after = await tools.read({path:"raw:bytes.txt",offset:51200,limit:16});
if (after?.bytes.length !== 24) throw Error("Raw explicit-window behavior changed");
text("raw:" + raw.bytes.length);
store("limited",limited);
`,
      String.raw`
const found = await tools.search({path:load("limited"),query:"regex:row 2011$"});
if (found.matches.length !== 0) throw Error("Stored cap widened the requested range");
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
const shown=await tools.read({path:first});
const found=await tools.search({path:second,query:"BETA"});
if(!shown.text.includes("ALPHA")||found.matches.map(match=>match.text).join()!=="BETA") throw Error("A peer result expired at the common commit");
text(shown.text); text(found);
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });
});
test("store/load retains text and UUID composition; Search reads a changed file's current text but edits expire", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await runText(cwd, "text-result-store", [
      `store("source", await tools.read({path:"note.txt"}));`,
      `const source=load("source"); const uuid=source.id.slice("RESULT#".length); const found=await tools.search({path:uuid,query:"beta"}); text(await tools.replace({path:found,text:"BETA"}));`,
      `const current=await tools.search({path:load("source"),query:"alpha"}); if(current.matches.map(match=>match.line+":"+match.text).join()!=="1:alpha") throw Error("Search did not read the changed result's current text: "+JSON.stringify(current)); if((await tools.replace({path:load("source"),text:"ALPHA\\nBETA\\n"}))!==null) throw Error("An edit on the stored old result survived a write"); text("Old result searched, edit rejected");`,
    ]);
    for (let i = 0; i < 3; i++)
      expect(
        getToolExecution(run, `script-${i}`).isError,
        getToolResultText(run, `script-${i}`),
      ).toBe(false);
    expect(codemodeFailures(getToolResultText(run, "script-2"))).toMatch(
      /^1 of \d+ IDE calls failed:\n- replace RESULT#[\s\S]*expired/u,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\n");
  });
});

test("explicit-text errors require a current anchor, then allow explicit text again", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runText(cwd, "text-result-anchor-recovery", [
      `
if((await tools.replace({path:"note.txt",start:"betx",text:"BETA"}))!==null) throw Error("A missing exact text was applied");
if((await tools.replace({path:"note.txt",start:"beta",text:"BETA"}))!==null) throw Error("Explicit text retried without an anchor");
await tools.write({path:"note.txt",content:"ALPHA\\nbeta\\ngamma\\n"});
if((await tools.replace({path:"note.txt",start:"beta",text:"BETA"}))!==null) throw Error("An unanchored write bypassed recovery");
const current=await tools.read({path:"note.txt",views:["anchors"]});
const anchor=/^\\s*([0-9A-HJKMNP-TV-Z]{7})\\|beta/m.exec(current.text)?.[1];
if(!anchor) throw Error("Read did not show beta's anchor: "+current.text);
await tools.replace({path:"note.txt",start:anchor,text:"BETA"});
const recovered=await tools.read({path:"note.txt"});
if(recovered.text!=="ALPHA\\nBETA\\ngamma\\n") throw Error("Anchored recovery was not applied");
await tools.replace({path:"note.txt",start:"gamma",text:"GAMMA"});
`,
    ]);
    const output = getToolResultText(run, "script-0");
    expect(getToolExecution(run, "script-0").isError, output).toBe(false);
    const [failed, blocked, stillBlocked, ...others] = failedCalls(output);
    expect(others, output).toEqual([]);
    expect(failed).toMatch(/^replace note\.txt\n[\s\S]*anchor/u);
    expect(blocked).toMatch(/^replace note\.txt\n[\s\S]*blocked/u);
    expect(stillBlocked).toMatch(/^replace note\.txt\n[\s\S]*blocked/u);
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
const failed=(await tools.replace({path:"note.txt",start:"missing",text:"BAD"}))===null;
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
  "live terminal sessions compose through their source without granting filesystem authority",
  async () => {
    await withTempWorkspace(async (cwd) => {
      const run = await runText(cwd, "text-result-live-shell", [
        String.raw`
const started=await tools.bash({command:"IFS= read -r answer; printf 'resource:%s' \"$answer\"",background:true});
if(!started.session) throw Error("Missing shell session");
// Terminal input selects no text; a failure would be listed at the end of the result.
const written=await tools.write({path:started.session,content:"hello"});
if(written!==null) throw Error("Terminal Write was treated as a file: "+written);
const entered=await tools.insert({path:started.session,text:"Enter"});
if(entered!==null) throw Error("Terminal Insert was treated as a file: "+entered);
const shown=await tools.read({path:started.session});
if(!shown.text.includes("resource:hello")) throw Error("Shell output lost: "+shown.text);
const rejected=(await tools.replace({path:shown,start:"hello",text:"BAD"}))===null;
if(!rejected) throw Error("Shell output granted text-edit authority");
if((await tools.delete({path:shown}))!==null) throw Error("Terminal Delete selected text");
`,
      ]);
      expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
        false,
      );
      // Only the deliberately refused Replace of shell output fails.
      expect(codemodeFailures(getToolResultText(run, "script-0"))).toMatch(
        /^1 of \d+ IDE calls failed:\n- replace /u,
      );
      expect(getToolResultText(run, "script-0")).not.toContain("pi-terminal-write");
      expect(getToolResultText(run, "script-0")).not.toContain("pi-terminal-keys");
      expect(getToolResultText(run, "script-0")).not.toContain("Saved file.");
    });
  },
);
test("system envelopes cannot be inserted into file contents", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const run = await runText(cwd, "text-result-payload-guard", [
      `
// Read and Search values carry no envelope; a readable result string, such as lsp_search's, still
// starts with one. Rebuild it around an issued id.
const found=await tools.search({path:"note.txt",query:"alpha"});
const shown='<system-result note="Internal reference; not part of the file. Do not edit."><uuid>'+found.id.slice("RESULT#".length)+'</uuid></system-result>\\nalpha\\n';
if((await tools.write({path:"copy.txt",content:shown}))!==null) throw Error("A system envelope was written to a file");
text("System marker rejected");
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    expect(codemodeFailures(getToolResultText(run, "script-0"))).toMatch(
      /^1 of 2 IDE calls failed:\n- write copy\.txt\n {2}A system result reference is not file content\./u,
    );
    await expect(readFile(path.join(cwd, "copy.txt"), "utf8")).rejects.toThrow("ENOENT");
  });
});
