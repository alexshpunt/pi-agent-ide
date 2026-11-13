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

import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

type Call = Parameters<typeof toolCall>[0];

async function run(cwd: string, name: string, calls: readonly Call[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  await writeFile(path.join(cwd, "a.txt"), "alpha\n");
  await writeFile(path.join(cwd, "b.txt"), "beta\n");
  await writeFile(path.join(cwd, "c.txt"), "gamma\n");
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/fixtures/structured-results-fixture.ts"),
    ],
    tools: ["read", "search", "replace", "receipt_edit", "codemode"],
    conversation: [
      ...calls.map((call) =>
        assistantMessage([toolCall(call)], {
          stopReason: "toolUse",
        }),
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Continue a Codemode script after failed IDE calls");
}

const script = (id: string, code: string): Call => ({ id, name: "codemode", arguments: { code } });

function failureBlock(output: string): string {
  const block = codemodeFailures(output);
  expect(block, output).not.toBe("");
  return block;
}

test("a failed IDE call resolves to null, the script continues and its result lists the failure", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "codemode-failed-read", [
      script(
        "reads",
        `const values = await Promise.all(["a.txt", "missing.txt", "c.txt"].map((path) => tools.read({ path })));
text("shape:" + JSON.stringify(values.map((value) => (value === null ? null : typeof value))));`,
      ),
      script(
        "throws",
        `const value = await tools.read({ path: "missing.txt" });
throw new Error("stopped after " + value);`,
      ),
      { id: "direct", name: "read", arguments: { path: "missing.txt" } },
    ]);

    const reads = getToolResultText(result, "reads");
    expect(getToolExecution(result, "reads").isError, reads).toBe(false);
    expect(reads).toContain('shape:["object",null,"object"]');
    const block = failureBlock(reads);
    expect(block.startsWith("1 of 3 IDE calls failed:\n- read missing.txt\n")).toBe(true);
    expect(block).toContain("Search for the correct path.");
    expect(block).not.toContain("<system-result");
    expect(reads.indexOf("shape:")).toBeLessThan(reads.indexOf("1 of 3 IDE calls failed"));

    const thrown = getToolResultText(result, "throws");
    expect(getToolExecution(result, "throws").isError).toBe(true);
    expect(thrown).toContain("stopped after null");
    expect(failureBlock(thrown).startsWith("1 of 1 IDE call failed:\n- read missing.txt\n")).toBe(
      true,
    );

    const direct = getToolResultText(result, "direct");
    expect(getToolExecution(result, "direct").isError).toBe(true);
    expect(direct).toContain("Search for the correct path.");
    expect(direct).not.toContain("<system-result");
  });
});

test("IDE refusals resolve to null while Pi's own rejections still throw", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "codemode-refused-calls", [
      script(
        "refused",
        `const expired = await tools.read({ path: "RESULT#00000000-0000-4000-8000-000000000000" });
// A readable result string, such as lsp_search's, starts with its system-result envelope.
const found = await tools.search({ path: "a.txt", query: "alpha" });
const shown = '<system-result note="Internal reference; not part of the file. Do not edit."><uuid>' + found.id.slice("RESULT#".length) + "</uuid></system-result>\\nalpha";
const pasted = await tools.replace({ path: "a.txt", start: "alpha", text: shown });
const listed = await tools.search({ path: ["a.txt", "missing-dir"], query: "alpha" });
text("refused:" + (expired === null) + ":" + (pasted === null) + ":" + (listed === null));`,
      ),
      script(
        "invalid",
        `let rejected = "";
try { await tools.search({ path: "a.txt" }); } catch (error) { rejected = String(error); }
text("rejected:" + (rejected !== ""));`,
      ),
    ]);

    const refused = getToolResultText(result, "refused");
    expect(getToolExecution(result, "refused").isError, refused).toBe(false);
    expect(refused).toContain("refused:true:true:true");
    const block = failureBlock(refused);
    expect(block).toContain("3 of 4 IDE calls failed:");
    // Several sources of one field are a list; an arrow is kept for a target.
    expect(block).toContain("- search a.txt, missing-dir\n");
    // The block is last, after any guide the result carries.
    expect(block).not.toContain("# Guide:");
    expect(block).toContain("- read RESULT#00000000-0000-4000-8000-000000000000");
    expect(block).toContain("Result reference expired");
    expect(block).toContain("- replace a.txt");
    expect(block).toContain("A system result reference is not file content.");
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("alpha\n");

    const invalid = getToolResultText(result, "invalid");
    expect(invalid).toContain("rejected:true");
    expect(codemodeFailures(invalid)).toBe("");
  });
});

test("an edit that failed after changing files is listed with only the files it changed", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "codemode-partial-edit", [
      script(
        "partial",
        `await tools.receipt_edit({ path: "a.txt", text: "A\\n", fail: true });
await tools.receipt_edit({ path: "b.txt", text: "B\\n" });
const after = await tools.read({ path: "a.txt" });
text("after:" + after);`,
      ),
    ]);

    const output = getToolResultText(result, "partial");
    expect(output).toContain("after:null");
    const block = failureBlock(output);
    expect(block).toContain("2 of 3 IDE calls failed:");
    expect(block).toContain(
      "- receipt_edit a.txt\n  Changed: a.txt. Do not repeat this edit blindly; Read the files first.\n  The edit was accepted, then its editor batch failed when it was saved.\n  Fixture failed after writing\n- read a.txt\n  Editor batch failed before this tool.",
    );
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("A\n");
  });
});
