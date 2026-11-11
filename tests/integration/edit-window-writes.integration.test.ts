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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";

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
    tools: ["write", "read", "search", "replace", "move", "codemode"],
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
const found=String(await tools.search({path:file,query:"rename_me"}).then((value)=>value.result));
const refs=matches(found);
check(refs.length===12,"Expected 12 references: "+found.slice(0,400));
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
const found=String(await tools.search({path:file,query:"int block_b"}).then((value)=>value.result));
const ref=/SEARCH#[A-F\d]+:1:line/.exec(found)?.[0];
check(ref,"No line reference: "+found.slice(0,400));
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
const found=String(await tools.search({path:file,query:"rename_me"}).then((value)=>value.result));
const refs=matches(found);
const keeps=matches(String(await tools.search({path:file,query:'"keep(4)"'}).then((value)=>value.result)));
check(refs.length===6&&keeps.length===1,"Unexpected references: "+found.slice(0,400));
await window({replace:["rename_me(2)","rename_ME(2)"]});
const refused=await rejects(()=>tools.replace({path:[refs[1],refs[2]],text:"renamed"}));
check(refused.includes("rename_ME(2)"),"The refusal does not show the current line: "+refused);
await tools.replace({path:[refs[0],refs[3]],text:"renamed"});
await tools.replace({path:keeps,text:"kept"});
text("REFUSED "+refused);`,
    );
    expect(output).toContain("REFUSED");
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
