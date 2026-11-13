import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("token search selections cannot silently rewrite every match", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "words.txt"), "const alpha\nawait beta\n");
    await writeFile(path.join(cwd, "boolean.txt"), "red blue\n");
    await writeFile(path.join(cwd, "literal.txt"), "const x = await f\n");
    const code = `
function check(v, message) { if (!v) throw Error(message); }
const found = await tools.search({path:"words.txt",query:"const x = await f"});
check(found.matches.length > 1,"word fallback");
check(Object.keys(found).sort().join() === "complete,id,matches", "compact search value");
check(await tools.replace({path:found,text:"BAD"}) === null,"whole value must fail");
check(await tools.replace({path:found.id,text:"BAD"}) === null,"whole id must fail");
check(await tools.read({path:found}) !== null,"whole selection is readable");
check(await tools.copy({path:found,target:"literal.txt",targetStart:"end"}) === null,"bulk transfer must fail");
const scoped = await tools.search({path:found,query:"const"});
check(scoped.matches.length === 1,"read-only search scope");
check(await tools.replace({path:found.matches[0],text:"CONST"}) !== null,"individual match");
const bool = await tools.search({path:"boolean.txt",query:"red AND blue"});
check(await tools.replace({path:bool,text:"BAD"}) === null,"boolean bulk");
check(await tools.replace({path:bool.matches[0],text:"RED"}) !== null,"boolean match");
const literal = await tools.search({path:"literal.txt",query:'"const x = await f"'});
check(await tools.replace({path:literal,text:"replaced"}) !== null,"quoted literal");
text("done");`;
    const run = await new PiIntegrationTest({
      testName: "token-search-edit",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "read", "copy", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "search",
              arguments: { path: "words.txt", query: "const x = await f" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([toolCall({ id: "compose", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Safely edit Search results");
    expect(getToolExecution(run, "compose").isError, getToolResultText(run, "compose")).toBe(false);
    const output = getToolResultText(run, "compose");
    expect(output.split("4 of ")[0]).toContain("separate tokens, not the phrase");
    const failures = codemodeFailures(output);
    expect(failures).toMatch(/^4 of \d+ IDE calls failed:/u);
    expect(failures).toContain("const x = await f");
    expect(failures).toContain('"const x = await f"');
    expect(failures).toContain("red AND blue");
    expect(getToolResultText(run, "direct")).toMatch(/tokens|separate words/iu);
    expect(await readFile(path.join(cwd, "words.txt"), "utf8")).toBe("CONST alpha\nawait beta\n");
    expect(await readFile(path.join(cwd, "boolean.txt"), "utf8")).toBe("RED blue\n");
    expect(await readFile(path.join(cwd, "literal.txt"), "utf8")).toBe("replaced\n");
  });
});
