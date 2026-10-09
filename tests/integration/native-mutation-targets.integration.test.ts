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
      tools: ["read", "search", "replace", "write", "codemode"],
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

if(typeof first!=="string" || typeof second!=="string") throw Error("Accepted edits need public result handles");
const found=await tools.search({path:second,query:"BETA"});
if(!found.includes("BETA") || !found.includes(":2:12-16")) throw Error("Batch-peer shifts lost: "+found);
const outside=await tools.search({path:first,query:"café"});
if(!outside.includes("No matches found")) throw Error("Peer target widened");
const next=await tools.replace({path:found,text:"READY"});
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
              code: '// @options: {"timeout_ms":2000}\nconst accepted = await tools.replace({path:"note.txt",start:"alpha",text:"PENDING"}); if(typeof accepted !== "string" || !accepted.includes("<uuid>")) throw Error("No public reserved result"); text(accepted); while(true) {}',
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "rejected",
            name: "codemode",
            arguments: {
              code: 'const target = "owned-cancelled-target"; let rejected; try { await tools.read({path:target}); } catch(error) { rejected=String(error); } if(!rejected || !rejected.includes("interrupted before writing")) throw Error("Cancelled result gained authority or lost its rejection reason: "+rejected); text(rejected);',
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
