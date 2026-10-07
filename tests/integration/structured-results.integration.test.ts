import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

async function runContract(cwd: string, name: string, code: string) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: ["text-read-view-authority", "text-native-large-image"].includes(name),
    transport: name === "text-native-large-image" ? "rpc" : "tui",
    cwd,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/fixtures/structured-results-fixture.ts"),
    ],
    tools: ["read", "search", "replace", "select", "receipt_edit", "codemode", "diff"],
    conversation: [
      assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Done")]),
    ],
  }).run("Verify readable results and private source authority");
}

test("native scripts compose Search and Read and keep empty scopes empty", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runContract(
      cwd,
      "text-search-read-edit",
      `
const found=await tools.search({query:"beta",path:"note.txt"});
const shown=await tools.read({path:found});
if(typeof shown!=="string"||!shown.includes("beta")) throw Error("Selected text missing");
const accepted=await tools.replace({path:"note.txt",start:"beta",text:"BETA"});
if(!accepted.includes("not yet applied")) throw Error("Acceptance claimed a write");
const after=await tools.read({path:"note.txt"});
if(!after.includes("BETA")) throw Error("Continued before commit");
const empty=await tools.search({query:"__nothing__",path:"note.txt"});
text(await tools.replace({path:empty,text:"BAD"}));
`,
    );
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });
});

test("native text results preserve raw bytes, deliver images, show continuation and reject bad adapters", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "bytes.bin"), Buffer.from([0, 255, 195, 40]));
    await writeFile(
      path.join(cwd, "long.txt"),
      Array.from({ length: 2200 }, (_, i) => `line ${i}\n`).join(""),
    );
    const run = await runContract(
      cwd,
      "text-native-data",
      `
const bytes=await tools.read({path:"raw:bytes.bin",offset:-2,limit:2});
if(!bytes.includes("Bytes 2..4")||!bytes.includes("c3 28")) throw Error("Raw bytes altered");
text(await tools.read({path:"fixture-image:"}));
for(const args of [{path:"absent.txt"}]) {
  let rejected=false; try { await tools.read(args); } catch(error) { rejected=String(error).length>0; }
  if(!rejected) throw Error("Missing source looked empty");
}
for(const query of ["missing-adapter:value","invalid-adapter:value"]) {
  let rejected=false; try { await tools.search({query}); } catch(error) { rejected=String(error).length>0; }
  if(!rejected) throw Error("Invalid adapter accepted");
}
const long=await tools.read({path:"long.txt"});
if(!/offset|temp:/i.test(long)) throw Error("Clipping was hidden");
const next=await tools.read({path:"long.txt",offset:2001,limit:1});
if(!next.includes("line 2000")) throw Error("Continuation skipped data");
text(bytes);
`,
    );
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    expect(
      getToolResultMessage(run, "script").content.some((block) => block.type === "image"),
    ).toBe(true);
  });
});

test("a real image larger than the private JSON budget still reaches the native parent", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = path.resolve("assets/banner.png");
    const bytes = await readFile(source);
    expect(bytes.toString("base64").length).toBeGreaterThan(1024 * 1024);
    await copyFile(source, path.join(cwd, "banner.png"));
    const run = await runContract(
      cwd,
      "text-native-large-image",
      String.raw`
const shown=await tools.read({path:"banner.png"});
if(typeof shown!=="string" || shown.includes('"base64"')) throw Error("Image buffer leaked into text");
text(shown);
`,
    );
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    const images = getToolResultMessage(run, "script").content.filter(
      (block) => block.type === "image",
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.data).toBe(bytes.toString("base64"));
    expect(images[0]?.mimeType).toBe("image/png");
  });
});
test("transformed Read views remain readable but cannot authorize text edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "data.json"), '{"value":"kept"}\n');
    const run = await runContract(
      cwd,
      "text-read-view-authority",
      String.raw`
for(const args of [{path:"raw:data.json"},{path:"data.json",views:["jq:.value"]},{path:"."},{path:"fixture-image:"}]) {
  const shown=await tools.read(args);
  if(typeof shown!=="string") throw Error("View result leaked internals");
  let rejected=false; try { await tools.replace({path:shown,text:"BAD"}); } catch(error) { rejected=String(error).includes("selection"); }
  if(!rejected) throw Error("Transformed output gained edit authority: "+shown);
  text(await tools.read({path:shown}));
}
const anchored=await tools.read({path:"data.json",views:["anchors"]});
const selected=await tools.select({path:anchored,operation:{kind:"trim",side:"both"}});
text(await tools.replace({path:selected,text:'{"value":"changed"}'}));
`,
    );
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    expect(await readFile(path.join(cwd, "data.json"), "utf8")).toBe('{"value":"changed"}\n');
    expect(
      getToolResultMessage(run, "script").content.some((block) => block.type === "image"),
    ).toBe(true);
  });
});
test("automatic commits report partial writes and do not replay failed batches", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "a\n");
    await writeFile(path.join(cwd, "b.txt"), "b\n");
    const run = await runContract(
      cwd,
      "text-partial-commit",
      `
await tools.receipt_edit({path:"a.txt",text:"A\\n",fail:true});
await tools.receipt_edit({path:"b.txt",text:"B\\n"});
let failed=""; try { await tools.read({path:"a.txt"}); } catch(error) { failed=String(error); }
if(!failed.includes("Editor batch failed")) throw Error("Failed commit did not block dependent work");
text(failed);
text(await tools.read({path:"a.txt"}));
text(await tools.read({path:"b.txt"}));
`,
    );
    expect(getToolExecution(run, "script").isError).toBe(true);
    expect(getToolResultText(run, "script")).toContain("Editor batches: 1 committed");
    const details = getToolExecutionDetails(getToolExecution(run, "script")) as {
      editorBatchResults: {
        status: string;
        data: { operation: string; effect: string; files: { source: string; effect: string }[] };
      }[];
    };
    expect(details.editorBatchResults).toHaveLength(1);
    const receipt = details.editorBatchResults[0];
    if (!receipt) throw new Error("Missing automatic commit receipt");
    expect(receipt.status).toBe("partial");
    expect(receipt.data.operation).toBe("batch");
    expect(receipt.data.effect).toBe("applied");
    expect(
      receipt.data.files.map(({ source, effect }) => ({ source: path.basename(source), effect })),
    ).toEqual([
      { source: "a.txt", effect: "applied" },
      { source: "b.txt", effect: "applied" },
    ]);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B\n");
    expect(await readFile(path.join(cwd, "a.txt.writes"), "utf8")).toBe("write\n");
    expect(await readFile(path.join(cwd, "b.txt.writes"), "utf8")).toBe("write\n");
  });
});

test("Diff returns readable comparison without publishing its private record", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    await writeFile(path.join(cwd, "other.txt"), "beta\n");
    const run = await new PiIntegrationTest({
      testName: "text-diff",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["diff"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "diff",
              name: "diff",
              arguments: { before: "note.txt", after: "other.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Compare files without exposing internal records");
    expect(getToolExecution(run, "diff").isError, getToolResultText(run, "diff")).toBe(false);
    expect(getToolExecutionResult(run, "diff")).not.toHaveProperty("structuredContent");
    expect(getToolResultMessage(run, "diff")).not.toHaveProperty("structuredContent");
    expect(getToolResultText(run, "diff")).toContain("-alpha");
    expect(getToolResultText(run, "diff")).toContain("+beta");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\n");
    expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("beta\n");
  });
});
