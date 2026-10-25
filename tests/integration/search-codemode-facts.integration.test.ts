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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const coverageCode = `
function check(value, message) { if (!value) throw Error(message); }
const seed = await tools.ast_search({path:"sample.ts",pattern:"probe($ARG)",limit:1});
check(seed.hasMatches === true && seed.complete === false,"Limited search claimed complete coverage");
const zero = await tools.search({path:seed.result,query:"regex:absent"});
const some = await tools.search({path:seed.result,query:"regex:probe"});
check(zero.hasMatches === false && zero.complete === false,"Incomplete empty scope became absence");
check(some.hasMatches === true && some.complete === false,"Inherited incomplete coverage was lost");
let blocked = false;
try { await tools.replace({path:zero.result,text:"BAD"}); } catch { blocked = true; }
check(blocked,"Incomplete scope authorized an edit");
const clipped = await tools.search({path:"large.txt",query:"regex:entry",limit:1000});
check(clipped.hasMatches === true && clipped.complete === true,"Presentation clipping changed coverage");
check(clipped.result.length < 80000,"Large Search did not exercise bounded presentation");
const files = await tools.search({path:".",query:"files:note.txt"});
check(files.hasMatches === true && files.complete === true,"File search lost facts");
const custom = await tools.search({query:"facts:custom"});
check(custom.hasMatches === null && custom.complete === null,"Custom payload was interpreted as match facts");
check(Object.keys(custom).sort().join(",") === "complete,hasMatches,result","Private fields leaked");
for (const args of [{query:"facts:failed"}, {query:"entry",limit:1001}]) {
  let failed = false;
  try { await tools.search(args); } catch { failed = true; }
  check(failed,"Failed search became a successful value");
}
text("Coverage, clipping, unknown facts and failures verified");`;

test("Search separates incomplete coverage, clipped presentation, unknown facts and rejected calls", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "sample.ts"), "probe(first);\nprobe(second);\n");
    await writeFile(path.join(cwd, "note.txt"), "keep\n");
    await writeFile(
      path.join(cwd, "large.txt"),
      Array.from({ length: 150 }, (_, i) => `entry${i} ${"x".repeat(900)}`).join("\n") + "\n",
    );
    const run = await new PiIntegrationTest({
      testName: "search-codemode-coverage-facts",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/search-facts-provider.ts"),
        "builtin:codemode",
      ],
      tools: ["search", "ast_search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "coverage",
              name: "codemode",
              arguments: { code: coverageCode },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Inspect Search facts without treating incomplete or failed coverage as absence");
    expect(getToolExecution(run, "coverage").isError, getToolResultText(run, "coverage")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe(
      "probe(first);\nprobe(second);\n",
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\n");
  });
});

test("Search exposes facts in Codemode while preserving readable direct results and bounded edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const code = `
const empty = await tools.search({path:"note.txt",query:"regex:absent"});
if (typeof empty !== "object" || empty.hasMatches !== false || empty.complete !== true)
  throw Error("Complete empty Search did not expose facts: " + JSON.stringify(empty));
if (typeof empty.result !== "string") throw Error("Missing composable result");
const found = await tools.search({path:"note.txt",query:"regex:beta"});
if (found.hasMatches !== true || found.complete !== true) throw Error("Missing match facts");
store("searchFacts", found);
text("Search facts verified");`;
    const run = await new PiIntegrationTest({
      testName: "search-codemode-facts",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "search",
              arguments: { path: "note.txt", query: "regex:beta" },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "facts", name: "codemode", arguments: { code }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "compose",
              name: "codemode",
              arguments: {
                code: 'const saved=load("searchFacts"); await tools.replace({path:saved.result,text:"BETA"}); text("Bounded edit verified");',
              },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Use Search facts and its issued result without parsing display prose");
    for (const id of ["direct", "facts", "compose"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const direct = getToolResultText(run, "direct");
    expect(direct).toContain("beta");
    expect(direct).not.toContain('"hasMatches"');
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });
});
