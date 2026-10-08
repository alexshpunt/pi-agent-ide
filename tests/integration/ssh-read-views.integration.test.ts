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
async function read(request) {
  const r = await tools.read(request);
  check(r.status === "success", JSON.stringify(r));
  return r.data;
}
const local = await read({path:"note.txt"});
check(local.lines[0].content === "local same basename", "Remote lookup changed local routing");
const note = await read({path:root+"/note.txt",offset:2,limit:1,views:["anchors"]});
check(note.source === root+"/note.txt" && note.lines.length === 1 && note.lines[0].content === "café second" && note.lines[0].lineEnding === "\\r\\n", "Text window lost identity or CRLF");
check(note.target && note.lines[0].anchors.length > 0, "Exact source window lost authority");
const raw = await read({path:"raw:"+root+"/bytes.bin",offset:-2,limit:2});
check(raw.kind === "bytes" && raw.byteOffset === 3 && raw.totalBytes === 5 && JSON.stringify(raw.bytes) === "[10,13]", "Raw tail was decoded");
const eof = await read({path:"raw:"+root+"/bytes.bin",offset:100,limit:2});
check(eof.byteOffset === 5 && eof.bytes.length === 0, "Raw EOF did not clamp");
const zero = await read({path:"raw:"+root+"/bytes.bin",limit:0});
check(zero.bytes.length === 0 && zero.totalBytes === 5 && !zero.target, "Zero byte read gained text authority");
const long = await read({path:root+"/long.txt"});
check(long.truncated && long.continuation && long.lines.length === 2000, "Text clipping was hidden");
const next = await read({...long.continuation,limit:2});
check(next.source === root+"/long.txt" && next.startLine === 2001 && next.lines[0].content === "row 2000", "Text continuation changed owner or skipped rows");
const records = await read({path:root+"/records.jsonl",views:["jq:.id"]});
check(records.truncated && records.totalLines === 2205 && !records.target, "Derived JSON gained source authority or lost bounds: "+JSON.stringify({truncated:records.truncated,totalLines:records.totalLines,count:records.lines.length,target:records.target}));
const recordTail = await read({...records.continuation,views:["jq:.id"],limit:1});
check(recordTail.lines[0].content === "2000", "JSON continuation offset was applied to input records");
const last = await read({path:root+"/records.jsonl",views:["jq:.message"],offset:2205,limit:1});
check(last.lines[0].content === '"remote café"', "JSONL output window was not transformed first");
for (const identitySource of ["identity.json", root+"/identity.json"]) {
  const identity = await read({path:identitySource,views:["jq:."]});
  check(identity.lines[0].content === "42" && !identity.target && !identity.lines.some(l=>l.anchors?.length), "Identity jq output gained physical authority: "+JSON.stringify(identity));
}
const environment = await read({path:root+"/records.jsonl",views:["jq:env | keys"],limit:10});
check(!environment.lines.some(l=>l.content.includes("SSH_AUTH_SOCK") || l.content.includes("HOME")), "jq inherited account environment");
const picture = await read({path:root+"/picture.data"});
check(picture.kind === "native" && picture.source === root+"/picture.data" && picture.blocks.some(b=>b.type === "image") && !picture.target, "Image lost native payload or gained edit authority");
const pdf = await read({path:root+"/document.data"});
check(pdf.lines.some(l=>l.content.includes("Owned second page 43")) && !pdf.target, "PDF did not convert all pages readonly");
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
  const r = await tools.read(request);
  check(r.status === "error" && r.errors.length > 0 && !r.data?.target, "Rejected Read looked successful: "+JSON.stringify(r));
}
text({source:note.source,tail:raw.bytes,continued:next.startLine,jsonTail:last.lines[0].content,image:picture.source,pdf:pdf.source,readonly:true});
`;
    const run = await new PiIntegrationTest({
      testName: "ssh-read-views",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "codemode"],
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
    for (const [name, bytes] of files)
      expect(await readFile(path.join(fixture.workspace, name))).toEqual(Buffer.from(bytes));
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 150_000);
