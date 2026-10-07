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
