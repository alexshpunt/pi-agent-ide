import { readFile, writeFile } from "node:fs/promises";
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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

async function scenario(code: string, name: string, verify: (cwd: string) => Promise<void>) {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    await writeFile(path.join(cwd, "source.ts"), "export const count = 1;\n");
    await writeFile(
      path.join(cwd, "usage.ts"),
      'import { count as amount } from "./source";\nexport { count } from "./source";\nexport const value = amount;\n',
    );
    await writeFile(
      path.join(cwd, "shorthand.ts"),
      'import { count } from "./source";\nexport const local = { count };\n',
    );
    const run = await new PiIntegrationTest({
      testName: name,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "lsp_search", "replace", "read", "write"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "capture-edit", name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Edit using the declaration and its symbol name capture");
    expect(
      getToolExecution(run, "capture-edit").isError,
      getToolResultText(run, "capture-edit"),
    ).toBe(false);
    await verify(cwd);
  });
}

test("replacing a declaration name capture renames imports, re-exports and shorthand", async () => {
  await scenario(
    `const declaration = await tools.lsp_search({declaration:"source.ts#count"});
const name = declaration.matches[0].captures.name[0];
if (!name.id || name.text !== "count") throw Error("Missing name capture");
text(await tools.replace({path:name, text:"total"}));`,
    "name-capture-rename",
    async (cwd) => {
      expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe("export const total = 1;\n");
      expect(await readFile(path.join(cwd, "shorthand.ts"), "utf8")).toBe(
        'import { total } from "./source";\nexport const local = { count: total };\n',
      );
      expect(await readFile(path.join(cwd, "usage.ts"), "utf8")).toBe(
        'import { total as amount } from "./source";\nexport { total as count } from "./source";\nexport const value = amount;\n',
      );
    },
  );
}, 180_000);

test("replacing a whole declaration remains a text edit", async () => {
  await scenario(
    `const declaration = await tools.lsp_search({declaration:"source.ts#count"});
text(await tools.replace({path:declaration.matches[0], text:"export const other = 2;\\n"}));`,
    "declaration-text-edit",
    async (cwd) => {
      expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe("export const other = 2;\n");
      expect(await readFile(path.join(cwd, "usage.ts"), "utf8")).toContain(
        "import { count as amount }",
      );
    },
  );
}, 180_000);

test("a changed name capture cannot silently become a text edit", async () => {
  await scenario(
    `const declaration = await tools.lsp_search({declaration:"source.ts#count"});
const name = declaration.matches[0].captures.name[0];
await tools.replace({path:"source.ts", start:"export const count = 1;", text:"export const other = 1;"});
if (await tools.replace({path:name, text:"total"}) !== null) throw Error("Stale capture succeeded");`,
    "stale-name-capture",
    async (cwd) => {
      expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toContain(
        "export const other = 1;",
      );
      expect(await readFile(path.join(cwd, "usage.ts"), "utf8")).toContain(
        "import { count as amount }",
      );
    },
  );
}, 180_000);

test("a name capture retains LSP semantics beside an independent native batch edit", async () => {
  await scenario(
    `const declaration = await tools.lsp_search({declaration:"source.ts#count"});
const name = declaration.matches[0].captures.name[0];
await tools.write({path:"independent.txt",content:"before"});
const results = await Promise.all([
  tools.replace({path:{...name, text:"forged", path:"usage.ts", line:999},text:"total"}),
  tools.replace({path:"independent.txt",start:"before",text:"after"})
]);
if (results.some(result => result === null)) throw Error("Concurrent edit failed");`,
    "name-capture-batch",
    async (cwd) => {
      expect(await readFile(path.join(cwd, "independent.txt"), "utf8")).toBe("after");
      expect(await readFile(path.join(cwd, "usage.ts"), "utf8")).toContain(
        "import { total as amount }",
      );
    },
  );
}, 180_000);

test("invalid and mixed name-capture requests never fall back to text replacement", async () => {
  await scenario(
    `const declaration = await tools.lsp_search({declaration:"source.ts#count"});
const name = declaration.matches[0].captures.name[0];
for (const args of [
  {path:name,text:""}, {path:name,start:"count",text:"total"},
  {path:[name,declaration.matches[0]],text:"total"}
]) if (await tools.replace(args) !== null) throw Error("Invalid capture edit succeeded");`,
    "name-capture-refusals",
    async (cwd) => {
      expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe("export const count = 1;\n");
      expect(await readFile(path.join(cwd, "usage.ts"), "utf8")).toContain(
        "import { count as amount }",
      );
    },
  );
}, 180_000);
