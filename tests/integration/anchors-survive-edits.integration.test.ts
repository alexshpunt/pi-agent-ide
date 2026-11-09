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

test("Search results and line anchors survive edits made elsewhere in the file", async () => {
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
    const source = ".tmp/shared/main.txt";
    // Another session edits the file through the shell between the agent's calls.
    const code =
      textResultChecks +
      `
const file=${JSON.stringify(source)};
await tools.write({path:file,content:"one\\ntwo\\nthree\\nfour\\nfive\\n"});
const anchored=await tools.read({path:file,views:["anchors"]});
const anchorOf=(word)=>new RegExp("(\\\\d+#[A-Z0-9]{3,4})\\\\|"+word).exec(anchored)[1];
const four=await tools.search({path:file,query:"four"}).then(value => value.result);
const two=await tools.search({path:file,query:"two"}).then(value => value.result);
const five=anchorOf("five");
const three=anchorOf("three");
await tools.bash({command:"sed -i '1i zero' "+file});
await tools.replace({path:matches(four)[0],text:"FOUR"});
await tools.replace({path:file,start:five,text:"LAST\\n"});
check(body(await tools.read({path:file})).startsWith("zero\\none\\ntwo\\nthree\\nFOUR\\nLAST"),"Edits above did not keep the targets");
await tools.bash({command:"sed -i 's/two/2/' "+file});
const changedResult=await rejects(()=>tools.replace({path:matches(two)[0],text:"X"}),/expired|stale/);
await tools.bash({command:"sed -i 's/three/3/' "+file});
const changedAnchor=await rejects(()=>tools.replace({path:file,start:three,text:"X\\n"}),/stale/);
text(changedResult); text(changedAnchor);`;
    const run = await new PiIntegrationTest({
      testName: "anchors-survive-edits",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "search", "replace", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Targets checked.")]),
      ],
    }).run("Edit the file after another session changed it elsewhere");
    expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, source), "utf8")).toBe("zero\none\n2\n3\nFOUR\nLAST\n");
  });
});
