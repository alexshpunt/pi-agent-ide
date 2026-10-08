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

test("pending native results gain exact authority only after their original-snapshot batch commits", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        disabled: [
          "ide.lsp",
          "ide.lint",
          "ide.formatter",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    await writeFile(path.join(cwd, "note.txt"), "alpha café beta\r\n");
    const run = await new PiIntegrationTest({
      testName: "native-mutation-targets",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "replace", "write", "flush", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "pending",
            name: "codemode",
            arguments: {
              code: `
text(await tools.read({path:"note.txt"}));
const first = await tools.replace({path:"note.txt",start:"alpha",text:"first\\nalpha"});
const second = await tools.replace({path:"note.txt",start:"beta",text:"BETA"});
if(first.data.effect !== "pending" || second.data.effect !== "pending") throw Error("Local edits should share original snapshots");
if(typeof first.data.target !== "string" || typeof second.data.target !== "string") throw Error("Accepted edits need reserved targets");
const found = await tools.search({path:second,query:"BETA"});
if(found.status !== "success" || found.data.matches.length !== 1) throw Error(JSON.stringify(found));
const range = found.data.matches[0].range;
if(range.startLine !== 2 || range.startColumn !== 11 || range.endColumn !== 15) throw Error("Batch-peer shifts lost: " + JSON.stringify(found));
const outside = await tools.search({path:first,query:"café"});
if(outside.status !== "success" || outside.data.matches.length !== 0) throw Error("A peer target widened to unchanged text");
const next = await tools.replace({path:found,text:"READY"});
if(next.status !== "success") throw Error(JSON.stringify(next));
text({first,second,found,outside,next});
`,
            },
          }),
        ]),
        assistantMessage([
          text("Pending handles were confirmed against the actual written batch."),
        ]),
      ],
    }).run("Check exact pending result authority and peer shifts through public native tools.");
    expect(getToolExecution(run, "pending").isError, getToolResultText(run, "pending")).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(
      "first\r\nalpha café READY\r\n",
    );
  });
}, 90000);

test("cancelled pending results are rejected rather than becoming editable authority", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        disabled: [
          "ide.lsp",
          "ide.lint",
          "ide.formatter",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    await writeFile(path.join(cwd, "note.txt"), "alpha café\n");
    const run = await new PiIntegrationTest({
      testName: "native-mutation-target-rejection",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/support/mutation-target-rejection-extension.ts"),
      ],
      tools: ["read", "replace", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "cancel",
            name: "codemode",
            arguments: {
              code: '// @options: {"timeout_ms":2000}\nconst accepted = await tools.replace({path:"note.txt",start:"alpha",text:"PENDING"}); if(typeof accepted.data.target !== "string") throw Error("No reserved target"); text(accepted); while(true) {}',
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "rejected",
            name: "codemode",
            arguments: {
              code: 'const target = "owned-cancelled-target"; const rejected = await tools.read({path:target}); if(rejected.status !== "error" || !JSON.stringify(rejected.errors).includes("cancelled")) throw Error("Cancelled target gained authority or lost its rejection reason: " + JSON.stringify(rejected)); text(rejected);',
            },
          }),
        ]),
        assistantMessage([text("Cancelled acceptance never granted text authority.")]),
      ],
    }).run("Reject the exact reserved result after its pending publication is cancelled.");
    expect(getToolExecution(run, "cancel").isError).toBe(true);
    expect(getToolExecution(run, "rejected").isError, getToolResultText(run, "rejected")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha café\n");
  });
}, 90000);
