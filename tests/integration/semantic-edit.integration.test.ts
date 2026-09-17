import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("Apply copies and removes an exact LSP declaration without matching unrelated text", async () => {
  await withTempWorkspace(async (cwd) => {
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
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "semantic-edit",
              name: "apply",
              arguments: {
                source:
                  'const source = open("source.ts"); const destination = open("destination.ts"); const declaration = source.find("export class Example {\\n  value() { return 1; }\\n}\\n"); destination.insertAfter(destination.find("// destination"), "\\n" + declaration.text); source.remove(declaration); flush();',
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

test("standalone declaration edits and Apply reject semantic insert without losing earlier effects", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "source.ts"),
      "export function first() { return 1; }\nexport function second() { return 2; }\n",
    );
    await writeFile(path.join(cwd, "destination.ts"), "// destination\n");
    const run = await new PiIntegrationTest({
      testName: "semantic-standalone-move",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace", "move", "apply"],
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
        assistantMessage(
          [
            toolCall({
              id: "no-semantic-insert",
              name: "apply",
              arguments: {
                source:
                  'if (typeof insert !== "undefined" || typeof replace !== "undefined") throw new Error("Legacy mutation helper was exposed");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace and move declarations, preserving explicit unsupported-operation boundaries");
    for (const id of ["declaration-replace", "declaration-move", "no-semantic-insert"]) {
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
      extensions: [path.resolve("src/pi-agent-ide.ts")],
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

test("Apply symbol search honors its file scope before applying the result limit", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    await writeFile(path.join(cwd, "first.ts"), "export class ScopedExample {}\n");
    await writeFile(path.join(cwd, "second.ts"), "export class ScopedExample {}\n");
    const run = await new PiIntegrationTest({
      testName: "semantic-scoped-search",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "scope",
              name: "apply",
              arguments: {
                source:
                  'const hit = search({query:"symbols:ScopedExample",path:"second.ts",limit:1}); if(hit.data.hits.length !== 1 || hit.data.hits[0].filePath !== "second.ts") throw new Error(JSON.stringify(hit)); const excluded = search({query:"symbols:ScopedExample",path:"second.ts",exclude:"second.ts"}); if(excluded.data.hits.length !== 0) throw new Error("Excluded symbol returned");',
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
    await writeFile(
      path.join(cwd, "nodes.ts"),
      'console.log(\n  "same"\n); console.log(\n  "same"\n);\n',
    );
    const run = await new PiIntegrationTest({
      testName: "semantic-ast-selection",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "ast-edit",
              name: "apply",
              arguments: {
                source:
                  'const found = search({query:"ast:console.log($ARG)",path:"nodes.ts"}); if(found.data.matches.length!==2) throw new Error("Missing AST selections"); const doc = open("nodes.ts"); doc.replace(doc.select(found.data.matches[1]), "logger.info(42)"); flush();',
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

test("Apply refreshes editor handles and AST selections after checkpoints", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "nodes.ts"), 'const emoji = "😀"; console.log("same");\n');
    const run = await new PiIntegrationTest({
      testName: "semantic-ast-refresh",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "refresh",
              name: "apply",
              arguments: {
                source: `
const firstSearch = search({query: "ast:console.log($ARG)", path: "nodes.ts"});
const first = open("nodes.ts");
first.replace(first.select(firstSearch.data.matches[0]), 'logger.info("same")');
flush();
first.replace(first.find("emoji"), "symbol");
flush();
const secondSearch = search({query: "ast:logger.info($ARG)", path: "nodes.ts"});
const second = open("nodes.ts");
second.replace(second.select(secondSearch.data.matches[0]), "done()");
flush();
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Refresh the editor handle and structural query after each checkpoint");
    const execution = getToolExecution(run, "refresh");
    expect(execution.isError, JSON.stringify(execution)).toBe(false);
    expect(await readFile(path.join(cwd, "nodes.ts"), "utf8")).toBe(
      'const symbol = "😀"; done();\n',
    );
  });
});
