import { PiIntegrationTest } from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withDeclarationSelections } from "#integration/support/declaration-selections.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

const source =
  'import { value } from "./helper";\nexport function doomed() { return value; }\nexport const label = "doomed";\n';
const consumer = 'import { doomed } from "./source";\nexport const result = doomed();\n';

for (const route of ["direct", "codemode", "read-result"] as const) {
  test(`declaration deletion through ${route} keeps the file and references`, async () => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      await writeFile(
        path.join(cwd, "tsconfig.json"),
        '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
      );
      await writeFile(path.join(cwd, "helper.ts"), "export const value = 1;\n");
      await writeFile(path.join(cwd, "source.ts"), source);
      await writeFile(path.join(cwd, "consumer.ts"), consumer);
      const call =
        route === "direct"
          ? toolCall({
              id: "delete-symbol",
              name: "delete",
              arguments: { path: "fixture:declaration:source.ts#doomed" },
            })
          : toolCall({
              id: "delete-symbol",
              name: "codemode",
              arguments: {
                code:
                  route === "read-result"
                    ? 'const declaration = await tools.lsp_search({declaration:"source.ts#doomed"}); text(await tools.delete({path:declaration}));'
                    : 'const declaration = await tools.lsp_search({declaration:"source.ts#doomed"}); if (!declaration.matches[0]?.text.includes("function doomed")) throw Error("Symbol did not resolve"); text(await tools.delete({path:declaration.matches[0]}));',
              },
            });
      const run = await new PiIntegrationTest(
        withDeclarationSelections({
          testName: `symbol-delete-${route}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
          tools: ["lsp_search", "delete", "codemode"],
          timeoutMs: 120_000,
          conversation: [
            assistantMessage([call], { stopReason: "toolUse" }),
            assistantMessage([text("Done")]),
          ],
        }),
      ).run("Delete only the doomed declaration; keep its source file, imports, and references");
      const execution = getToolExecution(run, "delete-symbol");
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
      expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe(
        source.replace("export function doomed() { return value; }\n", ""),
      );
      expect(await readFile(path.join(cwd, "consumer.ts"), "utf8")).toBe(consumer);
      const output = getToolResultText(run, "delete-symbol");
      expect(output).not.toContain("delete: applied");
    });
  });
}

test("invalid and ambiguous declarations cannot select files for deletion", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    const ambiguous = "export class First { ping() {} }\nexport class Second { ping() {} }\n";
    await writeFile(path.join(cwd, "source.ts"), ambiguous);
    const declarations = ["source.ts", "source.ts#missing", "source.ts#ping"];
    const run = await new PiIntegrationTest({
      testName: "declaration-delete-rejections",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["lsp_search"],
      timeoutMs: 120_000,
      conversation: [
        ...declarations.map((declaration, index) =>
          assistantMessage(
            [toolCall({ id: `reject-${index}`, name: "lsp_search", arguments: { declaration } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Reject invalid, missing, and ambiguous declarations without deleting any files");
    for (const index of declarations.keys())
      expect(getToolExecution(run, `reject-${index}`).isError).toBe(true);
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe(ambiguous);
  });
});
