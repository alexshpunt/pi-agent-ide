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
const declarations = await tools.ast_search({path:outline,pattern:"function $NAME() { $$$BODY }",relation:"enclosing"});
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
