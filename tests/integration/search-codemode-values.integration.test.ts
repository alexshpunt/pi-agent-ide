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

const coverageCode = `
function check(value, message) { if (!value) throw Error(message + ": " + JSON.stringify(value)); }
const seed = await tools.ast_search({path:"sample.ts",pattern:"probe($ARG)",limit:1});
check(seed.complete === false && seed.matches.length === 1,"Limited search claimed complete coverage");
check(seed.matches[0].captures.ARG[0].text === "first","AST capture lost its text");
const zero = await tools.search({path:seed,query:"regex:absent"});
const some = await tools.search({path:seed,query:"regex:probe"});
check(zero.matches.length === 0 && zero.complete === false,"Incomplete empty scope became absence");
check(some.matches.length === 1 && some.complete === false,"Inherited incomplete coverage was lost");
const blocked = (await tools.replace({path:zero,text:"BAD"})) === null;
check(blocked,"Incomplete scope authorized an edit");
const large = await tools.search({path:"large.txt",query:"regex:^entry\\\\d+ x+$"});
check(large.complete === true && large.matches.length === 150,"Search value lost matches");
check(large.matches.every((match, index) => match.path === "large.txt" && match.line === index + 1),"Match lines or paths changed");
check(large.matches[149].lineText === large.matches[149].text,"Long line context was cut");
check(large.matches[149].text.length > 4096 && large.matches[149].text.startsWith("entry149 "),"Long match text was cut");
const literal = await tools.search({path:"cpp.txt",query:'"flags | MASK"'});
check(literal.matches[0].text === "flags | MASK" && literal.matches[0].lineText === "  int x = flags | MASK; // PASS-MARKER","Literal context");
const multiline = await tools.search({path:"multiline.txt",query:"regex:first\\\\r?\\\\nlast",multiline:true});
check(multiline.matches[0].text === "first\\r\\nlast" && multiline.matches[0].lineText === "prefix first\\r\\nlast suffix","Multiline context");
const ast = await tools.ast_search({path:"multi.ts",pattern:"probe($$$ARGS)"});
check(ast.matches[0].lineText === "const result = probe(\\n  first,\\n  second\\n); // tail","AST multiline context");
const docs = await tools.search({path:"docs:terminal",query:"regex:^#"});
check(docs.matches.length > 0 && docs.matches.every(match => typeof match.lineText === "string" && !("id" in match)),"Readonly guide context");
const files = await tools.file_search({path:".",pattern:"note.txt"});
check(JSON.stringify(files) === '["note.txt"]',"File search lost its paths");
const custom = await tools.search({query:"facts:custom"});
check(typeof custom === "string" && custom.includes("Custom resolver response"),"Custom payload was interpreted as matches");
// A failed Search resolves to null; arguments outside the schema are still rejected by Pi.
check((await tools.search({query:"facts:failed"})) === null,"Failed search became a successful value");
let invalid = false;
try { await tools.search({query:"entry",limit:1001}); } catch { invalid = true; }
check(invalid,"Invalid search arguments became a successful value");
text("Coverage, complete match lists, custom results and failures verified");`;

test("Search values list every match and keep incomplete coverage, custom results and rejected calls apart", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "sample.ts"), "probe(first);\nprobe(second);\n");
    await writeFile(path.join(cwd, "note.txt"), "keep\n");
    await writeFile(path.join(cwd, "cpp.txt"), "  int x = flags | MASK; // PASS-MARKER\r\n");
    await writeFile(
      path.join(cwd, "multiline.txt"),
      "prefix first\r\nlast suffix\r\nuntouched\r\n",
    );
    await writeFile(
      path.join(cwd, "multi.ts"),
      "const result = probe(\n  first,\n  second\n); // tail\n",
    );
    await writeFile(
      path.join(cwd, "large.txt"),
      Array.from({ length: 150 }, (_, i) => `entry${i} ${"x".repeat(i === 149 ? 6000 : 900)}`).join(
        "\n",
      ) + "\n",
    );
    const run = await new PiIntegrationTest({
      testName: "search-codemode-coverage-values",
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
      tools: ["search", "file_search", "ast_search", "replace", "codemode"],
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
    }).run("Inspect Search values without treating incomplete or failed coverage as absence");
    expect(getToolExecution(run, "coverage").isError, getToolResultText(run, "coverage")).toBe(
      false,
    );
    const failures = codemodeFailures(getToolResultText(run, "coverage"));
    expect(failures).toMatch(/^2 of \d+ IDE calls failed:\n/u);
    expect(failures).toContain("- replace RESULT#");
    expect(failures).toContain("- search\n");
    expect(await readFile(path.join(cwd, "sample.ts"), "utf8")).toBe(
      "probe(first);\nprobe(second);\n",
    );
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\n");
  });
});

test("Search and ast_search values compose by match, capture and stored value while direct results stay readable", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\nbeta\n");
    await writeFile(path.join(cwd, "calls.ts"), "call(one);\ncall(two);\n");
    const code = `
function check(value, message) { if (!value) throw Error(message + ": " + JSON.stringify(value)); }
const empty = await tools.search({path:"note.txt",query:"regex:absent"});
check(empty.complete === true && empty.matches.length === 0 && /^RESULT#[a-f\\d-]{36}$/u.test(empty.id),"Complete empty Search");
check(await tools.replace({path:empty,text:"BAD"}) !== null,"Complete empty result must be a successful no-op");
check(await tools.replace({path:"note.txt",start:empty.id,text:"BAD"}) === null,"Empty endpoint must reject only its own call");
const found = await tools.search({path:"note.txt",query:"beta"});
check(found.complete === true && found.matches.length === 2,"Search matches");
check(found.matches.every((match) => match.path === "note.txt" && match.text === "beta" && match.id.startsWith("RESULT#")),"Match fields");
check(found.matches.map((match) => match.line).join() === "2,4","Match lines");
check(Object.keys(found).sort().join() === "complete,id,matches","Private fields leaked");
check(Object.keys(found.matches[0]).sort().join() === "id,line,lineText,path,text","Private match fields leaked");
check(await tools.replace({path:found.matches[1],text:"BETA2"}) !== null,"Replace one match by its value");
store("found", found);
const calls = await tools.ast_search({path:"calls.ts",pattern:"call($ARG)"});
check(calls.matches.map((match) => match.captures.ARG[0].text).join() === "one,two","Capture texts");
for (const match of calls.matches) {
  const [arg] = match.captures.ARG;
  check(await tools.replace({path:arg.id,text:arg.text.toUpperCase()}) !== null,"Replace a capture by its id");
}
text("Search values verified");`;
    const run = await new PiIntegrationTest({
      testName: "search-codemode-values",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "file_search", "ast_search", "replace", "codemode"],
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
          [toolCall({ id: "values", name: "codemode", arguments: { code }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "compose",
              name: "codemode",
              arguments: {
                // The stored match id follows the edit of the other match in the previous script.
                code: 'const saved=load("found"); if (await tools.replace({path:saved.matches[0].id,text:"BETA1"}) === null) throw Error("Stored match id"); text("Stored value verified");',
              },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Use Search values and their ids without parsing display prose");
    for (const id of ["direct", "values", "compose"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(codemodeFailures(getToolResultText(run, "values"))).toMatch(
      /^1 of \d+ IDE calls failed:\n/u,
    );
    expect(codemodeFailures(getToolResultText(run, "compose"))).toBe("");
    expect(run.tuiRenderedOutput).toContain("Stored value verified");
    const direct = getToolResultText(run, "direct");
    expect(direct).toContain("SEARCH#");
    expect(direct).toContain("note.txt:2:");
    expect(direct).not.toContain('"matches"');
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA1\ngamma\nBETA2\n");
    expect(await readFile(path.join(cwd, "calls.ts"), "utf8")).toBe("call(ONE);\ncall(TWO);\n");
  });
});
