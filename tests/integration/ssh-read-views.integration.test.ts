import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { createPdfFixture } from "#test-fixtures/pdf";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

// Exercise acquisition, conversion and result ownership through the real loader on both surfaces.
test("filesystem SSH Read keeps text, bytes, JSONL and media windows readonly and target scoped", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-read-view-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const remote = `ssh://fixture${fixture.workspace}`;
  const canvas = createCanvas(4, 3);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0000ff";
  context.fillRect(0, 0, 4, 3);
  const files = new Map<string, Uint8Array>([
    ["note.txt", Buffer.from("first\r\ncafé second\r\nlast\r\n")],
    ["bytes.bin", Buffer.from([0, 255, 128, 10, 13])],
    ["identity.json", Buffer.from("42\n")],
    ["long.txt", Buffer.from(Array.from({ length: 2205 }, (_, i) => `row ${i}\r\n`).join(""))],
    [
      "records.jsonl",
      Buffer.from(
        Array.from({ length: 2205 }, (_, id) =>
          JSON.stringify({ id, message: "remote café" }),
        ).join("\n"),
      ),
    ],
    ["broken.jsonl", Buffer.from('{"id":1}\n{"id":nope}\n')],
    ["picture.data", canvas.toBuffer("image/png")],
    ["broken.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["document.data", createPdfFixture(["Owned first page 42", "Owned second page 43"])],
    ["broken.pdf", Buffer.from("%PDF-1.4\nbroken\n")],
    ["denied.txt", Buffer.from("private synthetic denied content")],
  ]);
  try {
    for (const [name, bytes] of files) await writeFile(path.join(fixture.workspace, name), bytes);
    await chmod(path.join(fixture.workspace, "denied.txt"), 0o000);
    await writeFile(path.join(cwd, "note.txt"), "local same basename\n");
    await writeFile(path.join(cwd, "identity.json"), "42\n");
    await writeFile(
      path.join(cwd, "owned-module.jq"),
      'def owned_marker: "PRIVATE_MODULE_CANARY";\n',
    );
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.lsp",
          "ide.lint",
          "ide.formatter",
          "ide.debugger",
          "ide.vision",
          "ide.diagnostics",
        ],
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({
        targets: [
          {
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          },
        ],
      }),
    );
    const ordinary = [
      {
        id: "text",
        arguments: { path: `${remote}/note.txt`, offset: 2, limit: 1, views: ["anchors"] },
      },
      { id: "directory", arguments: { path: remote } },
      { id: "raw", arguments: { path: `raw:${remote}/bytes.bin`, offset: -2, limit: 2 } },
      {
        id: "jsonl",
        arguments: {
          path: `${remote}/records.jsonl`,
          views: ["jq:.message"],
          offset: 2205,
          limit: 1,
        },
      },
      { id: "image", arguments: { path: `${remote}/picture.data` } },
      { id: "pdf", arguments: { path: `${remote}/document.data` } },
      { id: "denied", arguments: { path: `${remote}/denied.txt` } },
      { id: "broken-json", arguments: { path: `${remote}/broken.jsonl`, views: ["jq:.id"] } },
      { id: "broken-image", arguments: { path: `${remote}/broken.png` } },
      { id: "broken-pdf", arguments: { path: `${remote}/broken.pdf` } },
    ];
    const code = `
const root = ${JSON.stringify(remote)};
function check(value, message) { if (!value) throw Error(message); }

async function rejected(action, label) {
  let failure; try { await action(); } catch(error) { failure=String(error); }
  check(failure, label+" unexpectedly succeeded");
}
const local=await tools.read({path:"note.txt"});
check(local.includes("local same basename"),"Local routing changed");
const note=await tools.read({path:root+"/note.txt",offset:2,limit:1,views:["anchors"]});
check(note.includes("café second") && !note.includes("first") && /2#[A-F0-9]+/.test(note),"Anchored text window changed");
const raw=await tools.read({path:"raw:"+root+"/bytes.bin",offset:-2,limit:2});
check(raw.includes("Bytes 3..5") && raw.includes("0a 0d"),"Raw tail was decoded");
const eof=await tools.read({path:"raw:"+root+"/bytes.bin",offset:100,limit:2});
check(eof.includes("Bytes 5..5"),"Raw EOF did not clamp");
const zero=await tools.read({path:"raw:"+root+"/bytes.bin",limit:0});
check(zero.includes("Bytes 0..0") && zero.includes("5 bytes total"),"Zero byte read changed bounds");
const long=await tools.read({path:root+"/long.txt"});
check(/offset|temp:/.test(long),"Clipping was hidden");
const next=await tools.read({path:root+"/long.txt",offset:2001,limit:2});
check(next.includes("row 2000") && next.includes("row 2001"),"Continuation skipped rows");
const records=await tools.read({path:root+"/records.jsonl",views:["jq:.id"]});
check(/offset|temp:/.test(records),"JSON clipping was hidden");
const recordTail=await tools.read({path:root+"/records.jsonl",views:["jq:.id"],offset:2001,limit:1});
check(recordTail.includes("2000"),"JSON continuation changed offset");
const last=await tools.read({path:root+"/records.jsonl",views:["jq:.message"],offset:2205,limit:1});
check(last.includes('"remote café"'),"JSONL output window was not transformed first");
for(const path of ["identity.json",root+"/identity.json"]) {
 const identity=await tools.read({path,views:["jq:."]});
 check(identity.includes("42"),"Identity jq output changed");
 await rejected(()=>tools.replace({path:identity,text:"BAD"}),"jq edit authority");
}
const environment=await tools.read({path:root+"/records.jsonl",views:["jq:env | keys"],limit:10});
check(!environment.includes("SSH_AUTH_SOCK") && !environment.includes('"HOME"'),"jq inherited account environment");
const picture=await tools.read({path:root+"/picture.data"});
const pdf=await tools.read({path:root+"/document.data"});
check(pdf.includes("Owned second page 43"),"PDF lost second page");
for(const result of [raw,zero,picture,pdf]) await rejected(()=>tools.replace({path:result,text:"BAD"}),"readonly edit authority");
for (const request of [
  {path:root+"/denied.txt"},
  {path:root+"/broken.jsonl",views:["jq:.id"]},
  {path:root+"/broken.png"},
  {path:root+"/broken.pdf"},
  {path:root+"/records.jsonl",views:["jq:include "+JSON.stringify(${JSON.stringify(path.join(cwd, "owned-module"))})+'; owned_marker']},
  {path:root+"/records.jsonl",views:['jq:include "owned-module" {search:'+JSON.stringify(${JSON.stringify(cwd)})+'}; owned_marker']},
  {path:root+"/records.jsonl",views:['jq:import "owned-module" as owned {search:'+JSON.stringify(${JSON.stringify(cwd)})+'}; owned::owned_marker']},
  {path:root+"/records.jsonl",views:["jq:.id","anchors"]},
  {path:"raw:"+root+"/bytes.bin",views:["anchors"]}
]) {
  await rejected(()=>tools.read(request),"Rejected Read");
}
text({note,raw,next,last,picture,pdf,readonly:true});
`;
    const run = await new PiIntegrationTest({
      testName: "ssh-read-views",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "replace", "codemode"],
      timeoutMs: 120_000,
      conversation: [
        ...ordinary.map((call) => assistantMessage([toolCall({ ...call, name: "read" })])),
        assistantMessage([toolCall({ id: "native", name: "codemode", arguments: { code } })]),
        assistantMessage([
          toolCall({
            id: "final-text",
            name: "read",
            arguments: { path: `${remote}/note.txt`, offset: 2, limit: 1, views: ["anchors"] },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "final-pdf",
            name: "read",
            arguments: { path: `${remote}/document.data`, offset: -3, limit: 3 },
          }),
        ]),
        assistantMessage([text("Readonly SSH windows and conversions verified.")]),
      ],
    }).run(
      "Read only the configured synthetic SSH files, preserving source identity and byte boundaries.",
    );
    for (const id of ["text", "directory", "raw", "jsonl", "image", "pdf", "native"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    for (const id of ["denied", "broken-json", "broken-image", "broken-pdf"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(true);
    expect(getToolResultText(run, "text")).toContain("café second");
    expect(getToolResultText(run, "text")).not.toContain("local same basename");
    expect(getToolResultText(run, "directory")).toContain("picture.data");
    expect(getToolResultText(run, "denied")).not.toContain("private synthetic denied content");
    expect(getToolResultText(run, "pdf")).toContain("Owned first page 42");
    expect(getToolResultText(run, "pdf")).toContain("Owned second page 43");
    const image = getToolResultMessage(run, "image").content.find((b) => b.type === "image");
    if (!image) throw Error("Ordinary SSH Read lost its image block");
    const decoded = await loadImage(Buffer.from(image.data, "base64"));
    expect([decoded.width, decoded.height]).toEqual([4, 3]);
    expect(run.tuiRenderedOutput).toContain(`${remote}/note.txt`);
    expect(run.tuiRenderedOutput).toContain("café second");
    expect(run.tuiRenderedOutput).toContain("Owned second page 43");
    // The controller may also be unprivileged; restore access only after checking refusal.
    await chmod(path.join(fixture.workspace, "denied.txt"), 0o644);
    for (const [name, bytes] of files)
      expect(await readFile(path.join(fixture.workspace, name))).toEqual(Buffer.from(bytes));
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 150_000);
