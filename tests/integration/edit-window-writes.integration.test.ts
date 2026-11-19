import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

const source = ".tmp/shared/main.cpp";

/**
 * Run one Codemode script. `window(write)` in the script asks the fixture to write the file once,
 * after the next edit checked its references and before it takes the file lock.
 */
async function runInWindow(cwd: string, name: string, content: string, script: string) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  await mkdir(path.join(cwd, ".tmp/shared"), { recursive: true });
  await writeFile(path.join(cwd, source), content);
  const code =
    textResultChecks +
    String.raw`
const file=${JSON.stringify(source)};
const window=(write)=>tools.write({path:".tmp/edit-window/write.json",content:JSON.stringify({file,...write})});
` +
    script;
  const run = await new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: false,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/fixtures/write-in-edit-window.ts"),
    ],
    tools: ["write", "read", "search", "replace", "move", "bash", "codemode"],
    conversation: [
      assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Done.")]),
    ],
  }).run("Edit by references while another session writes the file");
  const output = getToolResultText(run, "composed");
  expect(getToolExecution(run, "composed").isError, output).toBe(false);
  return { output, final: await readFile(path.join(cwd, source), "utf8") };
}

test("A whole-file Write based on an earlier Read does not discard a peer's write before the transaction", async () => {
  await withTempWorkspace(async (cwd) => {
    const original = "int task = 0;\nint peer = 0;\n";
    const { output, final } = await runInWindow(
      cwd,
      "edit-window-write-stale-read",
      original,
      String.raw`
const prior=await tools.read({path:file});
const peer=await tools.bash({command:"printf 'int task = 0;\\nint peer = 1;\\n' > "+file});
check(peer.exit_code===0,"Peer write failed");
// Search does not bless a new whole-file snapshot; the partial Read does not show the peer's line.
await tools.search({path:file,query:"task"});
await tools.read({path:file,offset:1,limit:1});
await rejects(()=>tools.write({path:"./"+file,content:prior.text.replace("task = 0","task = 1")}));
const fresh=await tools.read({path:file});
check(fresh.text.includes("peer = 1"),"Peer's change was lost");
await tools.write({path:file,content:fresh.text.replace("task = 0","task = 2")});
await tools.write({path:file,content:fresh.text.replace("task = 0","task = 3")});`,
    );
    expect(codemodeFailures(output)).toMatch(/^1 of \d+ IDE calls failed:\n- write /u);
    expect(final).toBe("int task = 3;\nint peer = 1;\n");
  });
});

test("A whole-file Write refuses a peer edit between result verification and the transaction", async () => {
  await withTempWorkspace(async (cwd) => {
    const { output, final } = await runInWindow(
      cwd,
      "edit-window-write-result",
      "int task = 0;\nint peer = 0;\n",
      String.raw`
const prior=await tools.read({path:file});
await window({replace:["peer = 0", "peer = 1"]});
await rejects(()=>tools.write({path:prior,content:prior.text.replace("task = 0","task = 1")}));`,
    );
    expect(codemodeFailures(output)).toMatch(/^1 of \d+ IDE calls failed:\n- write /u);
    expect(final).toBe("int task = 0;\nint peer = 1;\n");
  });
});
test("Direct Write refuses stale content and permits creation and a fresh overwrite", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = "shared.txt";
    const original = "task old\npeer old\n";
    const peerVersion = "task old\npeer new\n";
    const rebuilt = "task new\npeer new\n";
    await writeFile(path.join(cwd, file), original);
    const turn = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const run = await new PiIntegrationTest({
      testName: "direct-stale-write",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "write", "bash"],
      conversation: [
        turn("observed", "read", { path: file }),
        turn("peer", "bash", { command: "printf 'task old\\npeer new\\n' > shared.txt" }),
        turn("stale", "write", { path: "./" + file, content: "task new\npeer old\n" }),
        turn("fresh", "read", { path: file }),
        turn("rebuilt", "write", { path: file, content: rebuilt }),
        turn("new", "write", { path: "new.txt", content: "created\n" }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Refuse a stale whole-file overwrite, then recover with a fresh read");

    const refusal = getToolExecution(run, "stale");
    expect(refusal.isError).toBe(true);
    expect(getToolExecutionDetails(refusal)).toMatchObject({ effect: "not-applied" });
    expect(getToolResultText(run, "fresh")).toContain(peerVersion);
    expect(getToolExecution(run, "rebuilt").isError).toBe(false);
    expect(getToolExecution(run, "new").isError).toBe(false);
    expect(await readFile(path.join(cwd, file), "utf8")).toBe(rebuilt);
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("created\n");
  });
});
const row = (index: number, name: string) =>
  `int f_${String(index)}() { return ${name}(${String(index)}) + keep(${String(index)}); }`;

test("A replace over a list of search references applies at the new positions when another session writes between its check and its write", async () => {
  await withTempWorkspace(async (cwd) => {
    const rows = Array.from({ length: 12 }, (_, index) => row(index, "rename_me"));
    const { final } = await runInWindow(
      cwd,
      "edit-window-replace-list",
      `${rows.join("\n")}\n`,
      String.raw`
const found=await tools.search({path:file,query:"rename_me"});
const refs=found.matches.map((match)=>match.id);
check(refs.length===12,"Expected 12 references: "+JSON.stringify(found).slice(0,400));
await window({prepend:"// peer one\n// peer two\n"});
await tools.replace({path:refs.filter((_,index)=>index%2===0),text:"renamed"});`,
    );
    const expected = rows.map((line, index) => (index % 2 === 0 ? row(index, "renamed") : line));
    expect(final).toBe(`// peer one\n// peer two\n${expected.join("\n")}\n`);
  });
});

test("A move of a search result applies at the new position when another session writes between its check and its write", async () => {
  await withTempWorkspace(async (cwd) => {
    const { final } = await runInWindow(
      cwd,
      "edit-window-move-result",
      "// slot\nint keep_a;\nint block_b() { return 1; }\nint keep_c;\n",
      String.raw`
// The whole line with its line break, as a line reference selected it.
const found=await tools.search({path:file,query:"regex:^int block_b[^\\n]*\\n",multiline:true});
const ref=found.matches[0]?.id;
check(found.matches.length===1&&ref,"No line reference: "+JSON.stringify(found).slice(0,400));
await window({prepend:"// peer\n"});
await tools.move({path:ref,target:file,targetStart:"// slot",targetEnd:"// slot"});`,
    );
    expect(final).toBe("// peer\nint block_b() { return 1; }\nint keep_a;\nint keep_c;\n");
  });
});

test("A reference whose own text changed in that window is refused with its current line, and the file's other references stay usable", async () => {
  await withTempWorkspace(async (cwd) => {
    const rows = Array.from({ length: 6 }, (_, index) => row(index, "rename_me"));
    const { output, final } = await runInWindow(
      cwd,
      "edit-window-own-text-changed",
      `${rows.join("\n")}\n`,
      String.raw`
const found=await tools.search({path:file,query:"rename_me"});
const refs=found.matches.map((match)=>match.id);
const keeps=(await tools.search({path:file,query:"keep(4)"})).matches.map((match)=>match.id);
check(refs.length===6&&keeps.length===1,"Unexpected references: "+JSON.stringify(found).slice(0,400));
await window({replace:["rename_me(2)","rename_ME(2)"]});
await rejects(()=>tools.replace({path:[refs[1],refs[2]],text:"renamed"}));
await tools.replace({path:[refs[0],refs[3]],text:"renamed"});
await tools.replace({path:keeps,text:"kept"});`,
    );
    // The refusal shows the current line of the changed reference.
    const failures = codemodeFailures(output);
    expect(failures, output).toMatch(/^1 of \d+ IDE calls failed:\n- replace /u);
    expect(failures).toContain("rename_ME(2)");
    const expected = rows.map((line, index) =>
      index === 0 || index === 3
        ? row(index, "renamed")
        : index === 2
          ? line.replace("rename_me", "rename_ME")
          : line,
    );
    expected[4] = (expected[4] ?? "").replace("keep(4)", "kept");
    expect(final).toBe(`${expected.join("\n")}\n`);
  });
});

test("A move whose source and destination references were resolved on different texts of the file runs again on the current text", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const original =
      "int keep_a;\n// __SLOT__\nint keep_b;\nint block_x() {\n  return 1;\n}\nint keep_c;\n";
    await writeFile(path.join(cwd, "main.cpp"), original);
    const code =
      textResultChecks +
      String.raw`
// The whole slot line with its line break, as a line reference selected it.
const slot=await tools.search({path:"main.cpp",query:"regex:^// __SLOT__\\n",multiline:true});
const ref=slot.matches[0]?.id;
check(slot.matches.length===1&&ref,"No slot reference: "+JSON.stringify(slot).slice(0,300));
// The block is answered for the text before another session's write; the slot for the text after.
// Two answers: the batch planner's and the edit's first attempt; the rerun reads the file.
await tools.write({path:".tmp/block-targets/earlier.txt",content:JSON.stringify({text:${JSON.stringify(original)},times:2})});
await tools.bash({command:"sed -i '1i // peer' main.cpp"});
text(await tools.move({path:"BLOCK#block_x",target:"main.cpp",targetStart:ref,targetEnd:ref}));`;
    const run = await new PiIntegrationTest({
      testName: "edit-window-mixed-revisions",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/block-targets-read-earlier.ts"),
      ],
      tools: ["write", "search", "move", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done.")]),
      ],
    }).run("Move a block whose references were resolved on different texts");
    const output = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    expect(await readFile(path.join(cwd, "main.cpp"), "utf8")).toBe(
      "// peer\nint keep_a;\nint block_x() {\n  return 1;\n}\nint keep_b;\nint keep_c;\n",
    );
  });
});
