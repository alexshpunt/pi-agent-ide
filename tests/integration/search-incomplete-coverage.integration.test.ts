import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

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
    const code = `const seed = await tools.ast_search({pattern:"probe($ARG)",path:"sample.ts",limit:1});
const zero = await tools.search({path:seed,query:"regex:missing"});
const found = await tools.search({path:seed,query:"regex:probe"});
for (const value of [seed, zero, found])
  if (value.complete !== false) throw Error("Incomplete result claimed complete coverage: " + JSON.stringify(value));
if (zero.matches.length !== 0 || found.matches.length !== 1) throw Error(JSON.stringify([zero, found]));
// A refused edit resolves to null; the test checks its reason in the Codemode result.
const blocked = (await tools.replace({path:zero,text:"BAD"})) === null;
if (!blocked) throw Error("Incomplete zero result authorized an edit");
text("Incomplete values checked");`;
    const run = await new PiIntegrationTest({
      testName: "search-incomplete-coverage",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      // A fresh CLI process exercises project trust instead of reusing the SDK test host.
      tuiSize: { cols: 160, rows: 50 },
      isolateUserResources: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "ast_search", "replace", "codemode"],
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
    // The readable results of the nested searches, as a direct call shows them, keep the warning.
    const readable = getToolExecutions(run).flatMap(({ toolName, result }) =>
      toolName === "search" || toolName === "ast_search"
        ? [
            ((result as { content?: { type: string; text?: string }[] }).content ?? [])
              .map((block) => block.text ?? "")
              .join("\n"),
          ]
        : [],
    );
    expect(readable).toHaveLength(3);
    for (const shown of readable) {
      expect(shown).toContain("incomplete");
      expect(shown).not.toContain("limit reached");
    }
    expect(readable[1]).toContain("No matches found.");
    expect(readable[2]).toContain("1+ match");
    const refusal = codemodeFailures(getToolResultText(run, "incomplete-searches"));
    expect(refusal).toMatch(/^1 of 4 IDE calls failed:\n- replace RESULT#/u);
    expect(refusal).toMatch(/incomplete/iu);
    expect(run.tuiRenderedOutput).toContain("incomplete");
    expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe(source);
  });
});
