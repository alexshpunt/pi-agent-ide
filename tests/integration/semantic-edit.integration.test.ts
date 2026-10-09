import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { textResultChecks } from "#integration/support/text-result-checks.js";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

test("Native tools move an exact LSP declaration without matching unrelated text", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    );
    await writeFile(
      path.join(cwd, "source.ts"),
      'export class Example {\n  value() { return 1; }\n}\nexport const label = "Example";\n',
    );
    await writeFile(path.join(cwd, "destination.ts"), "// destination\n");
    const run = await new PiIntegrationTest({
      testName: "semantic-copy-remove",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "search", "select", "replace", "move"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "semantic-edit",
              name: "codemode",
              arguments: {
                code: 'const declaration=await tools.read({path:"symbol:source.ts#Example"}); if(typeof declaration!=="string") throw Error("Expected readable declaration"); const moved=await tools.move({path:declaration,target:"destination.ts",targetStart:"end"}); if(typeof moved!=="string") throw Error("Expected readable move"); text(moved);',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Copy the Example declaration and remove it from its original file");
    const execution = getToolExecution(run, "semantic-edit");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toContain(
      'export const label = "Example"',
    );
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).not.toContain("class Example");
    expect(await readFile(path.join(cwd, "destination.ts"), "utf8")).toContain("class Example");
    expect(await readFile(path.join(cwd, "destination.ts"), "utf8")).not.toContain(
      "export const label",
    );
  });
});

test("Copy warns that declaration fallback leaves imports and references unchanged", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    );
    await writeFile(path.join(cwd, "helper.ts"), "export const value = 1;\n");
    const source = 'import { value } from "./helper";\nexport function greet() { return value; }\n';
    const consumer = 'import { greet } from "./source";\nexport const result = greet();\n';
    await writeFile(path.join(cwd, "source.ts"), source);
    await writeFile(path.join(cwd, "consumer.ts"), consumer);
    await writeFile(path.join(cwd, "destination.ts"), "// destination\n");
    const run = await new PiIntegrationTest({
      testName: "semantic-copy-warning",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["copy", "codemode"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "copy-declaration",
              name: "copy",
              arguments: {
                path: "symbol:source.ts#greet",
                target: "destination.ts",
                targetStart: "end",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Copy only the declaration text; do not rewrite imports or references");
    const execution = getToolExecution(run, "copy-declaration");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    const output = getToolResultText(run, "copy-declaration");
    const details = getToolExecutionDetails(execution) as {
      results: { data: { diffStatuses?: { text: string; tone?: string }[] } }[];
    };
    const statuses = details.results.flatMap((result) => result.data.diffStatuses ?? []);
    const warning = statuses.find((status) => status.tone === "warning");
    if (warning === undefined) throw new Error("Missing declaration fallback warning");
    expect(output).toContain(warning.text);
    expect(run.tuiRenderedOutput).toContain(warning.text);
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe(source);
    expect(await readFile(path.join(cwd, "consumer.ts"), "utf8")).toBe(consumer);
    const copied = await readFile(path.join(cwd, "destination.ts"), "utf8");
    expect(copied).toContain("export function greet() { return value; }");
    expect(copied).not.toContain("import { value }");
  });
});
test("standalone declaration edits and moves preserve earlier effects", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(
      path.join(cwd, "source.ts"),
      "export function first() { return 1; }\nexport function second() { return 2; }\n",
    );
    await writeFile(path.join(cwd, "destination.ts"), "// destination\n");
    const run = await new PiIntegrationTest({
      testName: "semantic-standalone-move",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["replace", "move"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "declaration-replace",
              name: "replace",
              arguments: {
                path: "symbol:source.ts#first",
                text: "export function first() { return 3; }",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "declaration-move",
              name: "move",
              arguments: {
                path: "symbol:source.ts#second",
                target: "destination.ts",
                targetStart: "end",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace and move declarations, preserving explicit unsupported-operation boundaries");
    for (const id of ["declaration-replace", "declaration-move"]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
    }
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toContain("return 3");
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).not.toContain("function second");
    expect(await readFile(path.join(cwd, "destination.ts"), "utf8")).toContain("function second");
  });
});

test("standalone replace renames cross-file references without replacing unrelated names", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    );
    await writeFile(path.join(cwd, "source.ts"), 'export function greet() { return "greet"; }\n');
    await writeFile(
      path.join(cwd, "usage.ts"),
      'import { greet } from "./source";\nexport const answer = greet();\nfunction unrelated() { const greet = "local"; return greet; }\n',
    );
    const run = await new PiIntegrationTest({
      testName: "semantic-native-rename-replace",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["replace"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "rename",
              name: "replace",
              arguments: { path: "symbol:source.ts#greet#name", text: "welcome" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Rename greet through the language server, keeping unrelated names intact");
    expect(getToolExecution(run, "rename").isError).toBe(false);
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toContain(
      'function welcome() { return "greet"; }',
    );
    const usage = await readFile(path.join(cwd, "usage.ts"), "utf8");
    expect(usage).toContain("import { welcome }");
    expect(usage).toContain("answer = welcome()");
    expect(usage).toContain('const greet = "local"; return greet;');
  });
});

test("native symbol search honors its file scope before the result limit", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    await writeFile(path.join(cwd, "first.ts"), "export class ScopedExample {}\n");
    await writeFile(path.join(cwd, "second.ts"), "export class ScopedExample {}\n");
    const run = await new PiIntegrationTest({
      testName: "semantic-scoped-search",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "search", "select", "replace", "move"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "scope",
              name: "codemode",
              arguments: {
                code:
                  textResultChecks +
                  'const hit=await tools.search({query:"symbols:ScopedExample",path:"second.ts",limit:1}); check(matches(hit).length===1 && hit.includes("second.ts") && !hit.includes("first.ts"),"Symbol scope escaped"); const excluded=await tools.search({query:"symbols:ScopedExample",path:"second.ts",exclude:"second.ts"}); check(matches(excluded).length===0,"Symbol excludes ignored"); text(hit);',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Search only the selected file and respect excludes");
    const execution = getToolExecution(run, "scope");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
  });
});

test("AST search selections edit duplicate multiline nodes without text ambiguity", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(
      path.join(cwd, "nodes.ts"),
      'console.log(\n  "same"\n); console.log(\n  "same"\n);\n',
    );
    const run = await new PiIntegrationTest({
      testName: "semantic-ast-selection",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "search", "select", "replace", "move"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "ast-edit",
              name: "codemode",
              arguments: {
                code:
                  textResultChecks +
                  'const found=await tools.search({query:"ast:console.log($ARG)",path:"nodes.ts"}); check(matches(found).length===2,"Duplicate AST nodes lost"); const edited=await tools.replace({path:matches(found)[1],text:"logger.info(42)"}); check(typeof edited==="string","Expected readable edit"); text(edited);',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace only the second duplicate AST node by its registered exact range");
    const execution = getToolExecution(run, "ast-edit");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "nodes.ts"), "utf8")).toBe(
      'console.log(\n  "same"\n); logger.info(42);\n',
    );
  });
});

test("native AST edits use fresh selections after automatic commits", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "nodes.ts"), 'const emoji = "😀"; console.log("same");\n');
    const run = await new PiIntegrationTest({
      testName: "semantic-ast-refresh",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "search", "select", "replace", "move"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "refresh",
              name: "codemode",
              arguments: {
                code: `
const check=result=>{if(typeof result!=="string")throw Error("Expected readable result");return result;};
const firstSearch=check(await tools.search({query:"ast:console.log($ARG)",path:"nodes.ts"}));
check(await tools.replace({path:firstSearch.match(/SEARCH#[A-F0-9]+:1:match/)[0],text:'logger.info("same")'}));
check(await tools.replace({path:"nodes.ts",start:"emoji",text:"symbol"}));
const secondSearch=check(await tools.search({query:"ast:logger.info($ARG)",path:"nodes.ts"}));
check(await tools.replace({path:secondSearch.match(/SEARCH#[A-F0-9]+:1:match/)[0],text:"done()"}));
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Refresh the structural query after edits");
    const execution = getToolExecution(run, "refresh");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "nodes.ts"), "utf8")).toBe(
      'const symbol = "😀"; done();\n',
    );
  });
});
