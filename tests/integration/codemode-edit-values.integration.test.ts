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
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { withTextResultChecks } from "#integration/support/text-result-checks.ts";

// Each edit resolves to the id of the text it produced, or null when it selects none.
const script = `
const id = (value, what) => { check(typeof value==="string" && /^RESULT#[a-f0-9-]{36}$/.test(value), what+" did not resolve to an id: "+JSON.stringify(value)); return value; };
const replaced = id(await tools.replace({path:"a.txt",start:"alpha",text:"ALPHA"}), "Replace");
id(await tools.insert({path:"a.txt",anchor:"gamma",text:" delta"}), "Insert");
// The id of an edit still pending in the batch: the next call commits the batch first.
const found = await tools.search({path:replaced,query:"ALPHA"});
check(found.hasMatches===true && found.complete===true, "Search lost the pending replacement: "+found.result);
const chained = id(await tools.replace({path:replaced,text:"OMEGA"}), "Chained Replace");
// An edit whose target already has the text succeeds and still selects it.
id(await tools.replace({path:chained,text:"OMEGA"}), "Already-done Replace");
check(await tools.delete({path:"a.txt",start:"beta "})===null, "Delete selected text");
const written = id(await tools.write({path:"b.txt",content:"one\\ntwo\\n"}), "Write");
check((await tools.read({path:written})).text==="one\\ntwo\\n", "Write id lost the whole file");
const copied = id(await tools.copy({path:"b.txt",target:"c.txt"}), "Whole-file Copy");
check((await tools.read({path:copied})).text==="one\\ntwo\\n", "Copy id lost the destination");
id(await tools.move({path:"c.txt",target:"d.txt"}), "Whole-file Move");
const moved = id(await tools.move({path:"b.txt",start:"two\\n",target:"d.txt",targetStart:"begin"}), "Text Move");
check((await tools.search({path:moved,query:"two"})).hasMatches===true, "Move id lost the moved text");
check((await tools.search({path:moved,query:"one"})).hasMatches===false, "Move id widened past the moved text");
id(await tools.undo({file:"d.txt",change:"last"}), "Undo");
await tools.write({path:"dir/x.txt",content:"x\\n"});
check(await tools.copy({path:"dir",target:"dir2"})===null, "Directory Copy selected text");
check(await tools.delete({path:"d.txt"})===null, "File Delete selected text");
text("values checked");
`;

test("Codemode edit tools resolve to the id of the text they produced", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter", "ide.debugger"] }),
    );
    await writeFile(path.join(cwd, "a.txt"), "alpha beta gamma\n");
    const run = await new PiIntegrationTest({
      testName: "codemode-edit-values",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: [
        "read",
        "search",
        "replace",
        "insert",
        "delete",
        "write",
        "copy",
        "move",
        "undo",
        "codemode",
      ],
      timeoutMs: 60_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "values",
              name: "codemode",
              arguments: { code: withTextResultChecks(script) },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Edit values checked.")]),
      ],
    }).run("Check the values of Codemode edit tools");
    const output = getToolResultText(run, "values");
    expect(getToolExecution(run, "values").isError, output).toBe(false);
    expect(output).toContain("values checked");
    expect(codemodeFailures(output)).toBe("");
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("OMEGA gamma delta\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("one\n");
    await expect(readFile(path.join(cwd, "d.txt"))).rejects.toThrow("ENOENT");
  });
}, 90_000);
