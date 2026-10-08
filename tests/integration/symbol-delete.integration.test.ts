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
} from "#integration/support/pi-runtime/fixtures.js";

const source =
  'import { value } from "./helper";\nexport function doomed() { return value; }\nexport const label = "doomed";\n';
const consumer = 'import { doomed } from "./source";\nexport const result = doomed();\n';

for (const route of ["direct", "codemode", "read-result"] as const) {
  test(`symbol deletion through ${route} keeps the file and references`, async () => {
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
              arguments: { path: "symbol:source.ts#doomed" },
            })
          : toolCall({
              id: "delete-symbol",
              name: "codemode",
              arguments: {
                code:
                  route === "read-result"
                    ? 'const declaration = await tools.read({path:"symbol:source.ts#doomed"}); text(await tools.delete({path:declaration}));'
                    : 'const declaration = await tools.read({path:"symbol:source.ts#doomed"}); if (!declaration.includes("function doomed")) throw Error("Symbol did not resolve"); text(await tools.delete({path:"symbol:source.ts#doomed"}));',
              },
            });
      const run = await new PiIntegrationTest({
        testName: `symbol-delete-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "delete", "codemode"],
        timeoutMs: 120_000,
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage([text("Done")]),
        ],
      }).run("Delete only the doomed declaration; keep its source file, imports, and references");
      const execution = getToolExecution(run, "delete-symbol");
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
      expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe(
        source.replace(
          "export function doomed() { return value; }" + (route === "read-result" ? "\n" : ""),
          "",
        ),
      );
      expect(await readFile(path.join(cwd, "consumer.ts"), "utf8")).toBe(consumer);
      const output = getToolResultText(run, "delete-symbol");
      expect(output).not.toContain("delete: applied");
      if (route !== "read-result") {
        expect(output).toContain("Text fallback: imports and references unchanged");
      }
    });
  });
}

test("invalid and ambiguous symbol deletion cannot fall back to deleting files", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    const ambiguous = "export class First { ping() {} }\nexport class Second { ping() {} }\n";
    await writeFile(path.join(cwd, "source.ts"), ambiguous);
    // These are real regular files whose names match the broken whole-file route.
    const targets = ["symbol:source.ts", "symbol:source.ts#missing", "symbol:source.ts#ping"];
    for (const target of targets) await writeFile(path.join(cwd, target), "must remain\n");
    const run = await new PiIntegrationTest({
      testName: "symbol-delete-rejections",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["delete"],
      timeoutMs: 120_000,
      conversation: [
        ...targets.map((target, index) =>
          assistantMessage(
            [toolCall({ id: `reject-${index}`, name: "delete", arguments: { path: target } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Reject invalid, missing, and ambiguous declarations without deleting any files");
    for (const [index, target] of targets.entries()) {
      expect(getToolExecution(run, `reject-${index}`).isError).toBe(true);
      expect(await readFile(path.join(cwd, target), "utf8")).toBe("must remain\n");
    }
    expect(getToolResultText(run, "reject-0")).toContain("selector");
    expect(getToolResultText(run, "reject-1")).toContain("missing");
    expect(getToolResultText(run, "reject-2")).toContain("symbol:source.ts#ping");
    expect(await readFile(path.join(cwd, "source.ts"), "utf8")).toBe(ambiguous);
  });
});
