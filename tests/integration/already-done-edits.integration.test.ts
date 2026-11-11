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
import { withTextResultChecks } from "#integration/support/text-result-checks.ts";

const SOURCE = "call_a(x);\nFuncA(y);\nFuncA(z); call_a(w);\n";

async function run(
  cwd: string,
  name: string,
  calls: readonly ReturnType<typeof toolCall>[],
  disabled: readonly string[] = ["ide.lsp", "ide.lint"],
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), JSON.stringify({ disabled }));
  await writeFile(path.join(cwd, "names.cpp"), SOURCE);
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "replace", "delete", "move", "codemode"],
    conversation: [
      ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
      assistantMessage([text("Rename finished.")]),
    ],
  }).run("Rename call_a to FuncA where it is not renamed yet");
}

function codemode(id: string, code: string) {
  return toolCall({
    id,
    name: "codemode",
    arguments: { code: withTextResultChecks(code) },
    chunks: { kind: "fixed", size: 4096 },
    delayMs: 0,
  });
}

test("a direct replace whose target already has the text succeeds without a write", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "already-done-direct", [
      toolCall({
        id: "same",
        name: "replace",
        arguments: { path: "names.cpp", start: "FuncA(y)", text: "FuncA(y)" },
      }),
    ]);
    const output = getToolResultText(result, "same");
    expect(getToolExecution(result, "same").isError, output).toBe(false);
    expect(output).toContain("No changes: every target already has this text.");
    expect(output).toContain("Already had this text, left as is: 1 target at line:column 2:1.");
    expect(result.tuiRenderedOutput).toContain("No changes: every target already has this text.");
    expect(await readFile(path.join(cwd, "names.cpp"), "utf8")).toBe(SOURCE);
  });
});

test("a list of anchors applies the remaining targets and names the already-done ones", async () => {
  await withTempWorkspace(async (cwd) => {
    // The recorded case: half of the selected names were renamed before this call.
    const result = await run(cwd, "already-done-anchor-list", [
      codemode(
        "partial",
        `const found = (await tools.search({path:"names.cpp",query:"regex:call_a|FuncA"})).result;
const anchors = matches(found);
check(anchors.length===4,"Expected four name anchors: "+found);
text(await tools.replace({path:anchors,text:"FuncA"}));`,
      ),
      codemode(
        "all-done",
        `const found = (await tools.search({path:"names.cpp",query:"FuncA"})).result;
const done = await tools.replace({path:matches(found),text:"FuncA"});
check(done.includes("No changes: every target already has this text."),"Expected no changes: "+done);
const renamed = await tools.replace({path:done,text:"FuncB"});
text(renamed);`,
      ),
    ]);
    const partial = getToolResultText(result, "partial");
    expect(getToolExecution(result, "partial").isError, partial).toBe(false);
    expect(partial).toContain(
      "Already had this text, left as is: 2 targets at line:column 2:1, 3:1.",
    );
    const allDone = getToolResultText(result, "all-done");
    expect(getToolExecution(result, "all-done").isError, allDone).toBe(false);
    expect(await readFile(path.join(cwd, "names.cpp"), "utf8")).toBe(
      "FuncB(x);\nFuncB(y);\nFuncB(z); FuncB(w);\n",
    );
  });
});

test("a move onto a destination that already has the text still removes its source", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "spare.txt"), "keep FuncA keep\n");
    const result = await run(cwd, "already-done-move", [
      codemode(
        "move",
        `const source = (await tools.search({path:"spare.txt",query:"FuncA"})).result;
const target = matches((await tools.search({path:"names.cpp",query:"FuncA"})).result)[0];
text(await tools.move({path:source,target}));`,
      ),
    ]);
    const output = getToolResultText(result, "move");
    expect(getToolExecution(result, "move").isError, output).toBe(false);
    expect(output).toContain("Already had this text, left as is: 1 target at line:column 2:1.");
    expect(await readFile(path.join(cwd, "spare.txt"), "utf8")).toBe("keep  keep\n");
    expect(await readFile(path.join(cwd, "names.cpp"), "utf8")).toBe(SOURCE);
  });
});

test("a symbol rename to its current name succeeds without a write", async () => {
  await withTempWorkspace(async (cwd) => {
    const library =
      "export function alpha(): number {\n  return 1;\n}\nexport const value = alpha();\n";
    await writeFile(path.join(cwd, "lib.ts"), library);
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["lib.ts"] }),
    );
    const result = await run(
      cwd,
      "already-done-symbol-rename",
      [
        toolCall({
          id: "rename",
          name: "replace",
          arguments: { path: "symbol:lib.ts#alpha#name", text: "alpha" },
        }),
      ],
      ["ide.lint"],
    );
    const output = getToolResultText(result, "rename");
    expect(getToolExecution(result, "rename").isError, output).toBe(false);
    expect(output).toContain("No changes: every target already has this text.");
    expect(await readFile(path.join(cwd, "lib.ts"), "utf8")).toBe(library);
  });
});
