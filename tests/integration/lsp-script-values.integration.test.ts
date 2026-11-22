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
import { nestedResultTexts } from "#integration/support/nested-results.ts";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

/** More references than a direct call's record keeps. */
const USES = 150;
/** A declaration longer than the 4 KB of text a direct call's record keeps per match. */
const body = Array.from({ length: 400 }, (_, index) => `  total += ${String(index)};`).join("\n");
const source = [
  "export function validate(value: number): boolean {",
  "  return value > 0;",
  "}",
  "",
  "export function save(value: number): boolean {",
  "  let total = value;",
  body,
  "  return validate(total);",
  "}",
  "",
  "export function submit(): boolean {",
  "  return save(1);",
  "}",
  "",
  "export function retry(): boolean {",
  "  return save(2);",
  "}",
  "",
].join("\n");
const uses = `import { validate } from "./task";\n${Array.from(
  { length: USES },
  (_, index) => `export const use${String(index)} = validate(${String(index)});`,
).join("\n")}\n`;

const script = String.raw`
const check = (ok, message) => { if (!ok) throw Error(message); };
// Every reference, past the 100 a direct call's record keeps.
const references = await tools.lsp_search({ query: "validate", path: "task.ts", references: true });
check(references.complete === true, "References incomplete: " + JSON.stringify(references).slice(0, 300));
check(references.matches.length === ${String(USES)} + 3, "Lost references: " + references.matches.length);
check(references.matches.every((match) => match.text === "validate" && match.id.startsWith("RESULT#")), "A reference is not its name");
check(references.matches.every(match => typeof match.lineText === "string" && match.lineText.includes("validate")), "Missing reference line context");
// The whole declaration, past the 4 KB of text a direct call's record keeps.
const declaration = await tools.lsp_search({ declaration: "task.ts#save" });
check(declaration.matches.length === 1, "One declaration expected");
check(declaration.matches[0].line === 5 && declaration.matches[0].text.endsWith("  return validate(total);\n}\n"), "Declaration text cut: " + declaration.matches[0].text.slice(-80));
check(declaration.matches[0].text.length > 4096, "Declaration not long enough to prove anything");
check(declaration.matches[0].lineText === declaration.matches[0].text.replace(/\n$/u, ""), "Declaration line context");
const graph = await tools.lsp_search({ calls: "task.ts#save" });
check(graph.complete === true, "Graph incomplete");
check(graph.incoming.map((match) => match.line).join(",") === "${String(source.split("\n").indexOf("export function submit(): boolean {") + 1)},${String(source.split("\n").indexOf("export function retry(): boolean {") + 1)}", "Callers: " + JSON.stringify(graph.incoming));
check(graph.outgoing.length === 1 && graph.outgoing[0].text === "export function validate(value: number): boolean {\n  return value > 0;\n}\n", "Callee: " + JSON.stringify(graph.outgoing));
check(graph.matches.length === 3 && graph.matches.every((match) => match.text === "save"), "Graph references: " + JSON.stringify(graph.matches));
check([...graph.incoming, ...graph.outgoing].every(match => match.lineText === match.text.replace(/\n$/u, "")), "Graph line context");
// A caller's id selects its whole declaration.
await tools.delete({ path: graph.incoming[1] });
text("references=" + references.matches.length + " callers=" + graph.incoming.length);
`;

test("lsp_search gives a script every reference, whole declarations and a call graph with ids", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    );
    await writeFile(path.join(cwd, "task.ts"), source);
    await writeFile(path.join(cwd, "uses.ts"), uses);
    const run = await new PiIntegrationTest({
      testName: "lsp-script-values",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["lsp_search", "delete", "codemode"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "values", name: "codemode", arguments: { code: script } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect the references and calls of save and remove its caller retry");
    const execution = getToolExecution(run, "values");
    expect(execution.isError, getToolResultText(run, "values")).toBe(false);
    expect(getToolResultText(run, "values")).toContain(`references=${String(USES + 3)} callers=2`);
    expect(await readFile(path.join(cwd, "task.ts"), "utf8")).toBe(
      source.replace("export function retry(): boolean {\n  return save(2);\n}\n", ""),
    );
    // The direct readable results of the same calls are unchanged.
    const [listed, declared, graph] = nestedResultTexts(run, "lsp_search");
    expect(listed).toContain("LSP reference navigation");
    expect(listed).toContain("Preview shortened; full source targets retained.");
    expect(declared).toContain("declaration task.ts#save");
    expect(graph).toContain("## graph: save");
    expect(graph).toContain("Incoming calls: 2");
  });
}, 180_000);
