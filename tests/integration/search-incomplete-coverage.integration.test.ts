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

test("warns about inherited incomplete coverage for empty and non-empty searches", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ theme: "dark", codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    const source = "probe(first);\nprobe(second);\n";
    await writeFile(path.join(cwd, "sample.ts"), source);
    const code = `const seed = await tools.search({query:"ast:probe($ARG)",path:"sample.ts",limit:1});
const warning = "Search coverage is incomplete. Do not conclude absence or use this result as an edit scope.";
const zero = await tools.search({path:seed,query:"regex:missing"});
const found = await tools.search({path:seed,query:"regex:probe"});
for (const result of [seed, zero, found]) {
  if (!result.includes(warning)) throw Error("Incomplete result lost its warning: " + result);
  if (result.includes("limit reached")) throw Error("Incomplete scope was mislabeled as a new limit: " + result);
}
if (!zero.includes("No matches found.")) throw Error(zero);
if (!found.includes("1+ match")) throw Error(found);
let blocked = false;
try { await tools.replace({path:zero,text:"BAD"}); }
catch (error) { if (!/incomplete/i.test(String(error))) throw error; blocked = true; }
if (!blocked) throw Error("Incomplete zero result authorized an edit");
text(zero);
text(found);`;
    const run = await new PiIntegrationTest({
      testName: "search-incomplete-coverage",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      // A fresh CLI process exercises project trust instead of reusing the SDK test host.
      tuiSize: { cols: 160, rows: 50 },
      isolateUserResources: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "incomplete-searches", name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Incomplete coverage checked.")]),
      ],
    }).run("Search an incomplete AST result without treating zero matches as absence");
    expect(
      getToolExecution(run, "incomplete-searches").isError,
      getToolResultText(run, "incomplete-searches"),
    ).toBe(false);
    expect(run.tuiRenderedOutput).toContain("incomplete");
    expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe(source);
  });
});
