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

const source =
  "export function first() {\n  const hidden = 7;\n  return hidden;\n}\n\nexport function second() {\n  return 9;\n}\n";

test("outline returns reusable declaration selections while ast remains a text view", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "task.ts"), source);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        disabled: ["ide.lsp", "ide.lint"],
        noPostProcessing: true,
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "outline-composition",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["outline", "read", "search", "ast_search", "replace", "codemode"],
      conversation: [
        assistantMessage([
          toolCall({ id: "direct", name: "outline", arguments: { path: "task.ts" } }),
        ]),
        assistantMessage([
          toolCall({
            id: "script",
            name: "codemode",
            arguments: {
              code: `
const check = (value) => { if (!value) throw Error("outline contract failed"); };
const outline = await tools.outline({path:"task.ts"});
check(typeof outline.id === "string" && outline.id.startsWith("RESULT#"));
check(outline.text.includes("first()") && outline.text.includes("second()") && !outline.text.includes("const hidden"));
const names = await tools.search({path:outline,query:"first"});
check(names.matches.length === 1 && names.matches[0].line === 1);
const declarations = await tools.ast_search({path:outline,pattern:"export function $NAME() { $$$BODY }",relation:"enclosing"});
check(declarations.matches.length === 2);
text(await tools.replace({path:names.matches[0],start:"first",text:"renamed"}));
const scopes = await tools.read({path:"task.ts",views:["ast"]});
check(scopes.text.includes("const hidden = 7;") && scopes.text.includes("scope-begin-"));
text("outline-composed");
`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "removed", name: "read", arguments: { path: "ast:task.ts" } }),
        ]),
        assistantMessage([text("Finished")]),
      ],
    }).run("Inspect declarations with outline and reuse its result to search and edit.");
    for (const id of ["direct", "script"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const direct = getToolResultText(run, "direct");
    expect(direct).toContain("export function first()");
    expect(direct).not.toContain("const hidden");
    expect(getToolResultText(run, "script")).toContain("outline-composed");
    expect(getToolExecution(run, "removed").isError).toBe(true);
    expect(await readFile(path.join(cwd, "task.ts"), "utf8")).toBe(
      source.replace("first", "renamed"),
    );
  });
}, 90_000);

test("outline pages a large C++ file and reuses only the returned source rows", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    const cpp = [
      "int first() {",
      "  int hidden = 7;",
      "  hidden += 1;",
      "  return hidden;",
      "}",
      ...Array.from({ length: 26_000 }, (_, index) => `int entry_${index}() { return ${index}; }`),
      "int tail() { return 9; }",
      "",
    ].join("\n");
    await writeFile(path.join(cwd, "main.cpp"), cpp);
    const run = await new PiIntegrationTest({
      testName: "outline-large-cpp",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["outline", "search", "replace", "codemode"],
      conversation: [
        assistantMessage([
          toolCall({ id: "large-direct", name: "outline", arguments: { path: "main.cpp" } }),
        ]),
        assistantMessage([
          toolCall({
            id: "large-script",
            name: "codemode",
            arguments: {
              code: `
const page = await tools.outline({path:"main.cpp", offset:26003, limit:2});
if (!page.id?.startsWith("RESULT#") || !page.text.includes("tail()") ||
    !page.text.includes("entry_25999()") || page.text.includes("entry_25998()")) throw Error(page.text);
const all = await tools.search({path:page, query:"regex:first|tail|entry_25998"});
if (all.matches.length !== 1 || all.matches[0].line !== 26006) throw Error(JSON.stringify(all.matches));
const changed = await tools.replace({path:all.matches[0],start:"tail",text:"renamed"});
if (changed.isError) throw Error(JSON.stringify(changed));
`,
            },
          }),
        ]),
        assistantMessage([text("Finished")]),
      ],
    }).run("Open the declaration outline of main.cpp, then reuse its final page to rename tail.");
    for (const id of ["large-direct", "large-script"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const firstPage = getToolResultText(run, "large-direct");
    expect(firstPage).toContain("int first()");
    expect(firstPage).not.toContain("hidden");
    expect(firstPage).not.toContain("tail()");
    expect(firstPage.length).toBeLessThan(16 * 1024);
    expect(await readFile(path.join(cwd, "main.cpp"), "utf8")).toBe(cpp.replace("tail", "renamed"));
  });
}, 90_000);

test("outline rejects invalid file inputs and keeps an empty source reusable", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    await writeFile(path.join(cwd, "empty.ts"), "");
    await writeFile(path.join(cwd, "binary.ts"), "\0binary");
    await writeFile(path.join(cwd, "unsupported.txt"), "ordinary text");
    await writeFile(path.join(cwd, "large.ts"), "//" + "x".repeat(4 * 1024 * 1024));
    const inputs = [
      ...[
        "missing.ts",
        "binary.ts",
        "unsupported.txt",
        "large.ts",
        ".",
        "https://example.com/a.ts",
        "ast:empty.ts",
      ].map((path) => ({ path })),
      { path: "empty.ts", offset: 0 },
      { path: "empty.ts", offset: 2 },
      { path: "empty.ts", limit: 0 },
      { path: "empty.ts", limit: 101 },
    ];
    const run = await new PiIntegrationTest({
      testName: "outline-invalid-inputs",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["outline", "search", "codemode"],
      conversation: [
        ...inputs.map((input, index) =>
          assistantMessage([
            toolCall({
              id: "invalid-" + index,
              name: "outline",
              arguments: input,
            }),
          ]),
        ),
        assistantMessage([
          toolCall({
            id: "empty",
            name: "codemode",
            arguments: {
              code: `const value = await tools.outline({path:"empty.ts"});
if (!value.id?.startsWith("RESULT#")) throw Error("Missing empty source selection");
const found = await tools.search({path:value,query:"anything"});
if (found.matches.length !== 0) throw Error("Empty source produced matches");
text("empty-source");`,
            },
          }),
        ]),
        assistantMessage([text("Finished")]),
      ],
    }).run("Check outline errors and the empty file result.");
    for (let index = 0; index < inputs.length; index++)
      expect(getToolExecution(run, "invalid-" + index).isError, JSON.stringify(inputs[index])).toBe(
        true,
      );
    expect(getToolExecution(run, "empty").isError, getToolResultText(run, "empty")).toBe(false);
  });
}, 90_000);
