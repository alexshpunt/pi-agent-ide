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
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

test("Anchors of repeated lines survive another session moving the block above", async () => {
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
    const source = ".tmp/shared/blocks.cpp";
    const block = (name: string) => `template <typename T>\\nT ${name}(T v) {\\n  return v;\\n}\\n`;
    // Another session moves the first definition and the blank line after it to the end.
    const moveFirst = String.raw`perl -0pi -e 's/(template <typename T>\nT one.*?\n}\n\n)(.*)/$2$1/s' `;
    const code =
      textResultChecks +
      `
const file=${JSON.stringify(source)};
await tools.write({path:file,content:"#include <vector>\\n\\n${block("one")}\\n${block("two")}\\n// end\\n"});
const anchored=String(await tools.read({path:file,views:["anchors"]}));
const rows=anchored.split("\\n").filter((row)=>/^[0-9A-HJKMNP-TV-Z]{7}\\|/.test(row)).map((row)=>{const at=row.indexOf("|"); return {anchor:row.slice(0,at), text:row.slice(at+1)};});
const nth=(line,index)=>rows.filter((row)=>row.text===line)[index].anchor;
const secondTemplate=nth("template <typename T>",1);
const secondClose=nth("}",1);
const blankAfterFirst=nth("",1);
await tools.bash({command:${JSON.stringify(moveFirst)}+file});
check(body(await tools.read({path:file})).endsWith("// end\\n${block("one")}\\n"),"The block was not moved");
await tools.delete({path:file,start:secondTemplate,end:secondClose});
await rejects(()=>tools.insert({path:file,anchor:blankAfterFirst,text:"X\\n"}));`;
    const run = await new PiIntegrationTest({
      testName: "repeated-line-anchors-block-move",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "delete", "insert", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Targets checked.")]),
      ],
    }).run("Edit by anchors after another session moved the block above");
    const output = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    expect(codemodeFailures(output)).toMatch(
      /^1 of \d+ IDE calls failed:\n- insert \.tmp\/shared\/blocks\.cpp\n[\s\S]*stale/u,
    );
    // The second definition is gone; the blank line whose neighbour moved was not guessed.
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(
      "#include <vector>\n\n\n// end\ntemplate <typename T>\nT one(T v) {\n  return v;\n}\n\n",
    );
  });
});
