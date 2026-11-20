import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

type Call = Parameters<typeof toolCall>[0];

async function run(
  cwd: string,
  name: string,
  calls: readonly Call[],
  extensions: readonly string[] = [],
) {
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
      ...extensions,
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

function calls(result: Awaited<ReturnType<typeof run>>, id: string) {
  const details = getToolExecutionDetails(getToolExecution(result, id)) as {
    calls: { name: string; status: string; args: string }[];
  };
  return details.calls.map((call) => ({
    name: call.name,
    status: call.status,
    args: JSON.parse(call.args) as unknown,
  }));
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
    expect(reads).toContain("missing.txt");
    expect(calls(result, "reads")).toEqual([
      { name: "read", status: "ok", args: { path: "a.txt" } },
      { name: "read", status: "error", args: { path: "missing.txt" } },
      { name: "read", status: "ok", args: { path: "c.txt" } },
    ]);

    const thrown = getToolResultText(result, "throws");
    expect(getToolExecution(result, "throws").isError).toBe(true);
    expect(thrown).toContain("stopped after null");
    expect(thrown).toContain("missing.txt");
    expect(calls(result, "throws")).toEqual([
      { name: "read", status: "error", args: { path: "missing.txt" } },
    ]);

    const direct = getToolResultText(result, "direct");
    expect(getToolExecution(result, "direct").isError).toBe(true);
    expect(getToolExecutionDetails(getToolExecution(result, "direct"))).toHaveProperty(
      "failure.code",
      "READ_FAILED",
    );
    expect(direct).not.toContain("<system-result");
  });
});

test("Codemode retains recovery text added by a later provider result hook", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(
      cwd,
      "codemode-provider-recovery",
      [
        script(
          "nested",
          `const values = await Promise.all(["absent-a.txt", "absent-b.txt"].map(path => tools.read({path}))); text(JSON.stringify(values));`,
        ),
        script(
          "mixed",
          `const values = await tools.read({path:["a.txt", "absent-a.txt"]}); text(JSON.stringify(values.map(value => value === null)));`,
        ),
        script(
          "replaced",
          `const value = await tools.read({path:"replace-c.txt"}); text(JSON.stringify(value));`,
        ),
        { id: "direct", name: "read", arguments: { path: "absent-a.txt" } },
      ],
      [path.resolve("tests/integration/fixtures/failure-recovery.ts")],
    );
    const output = getToolResultText(result, "nested");
    expect(getToolExecution(result, "nested").isError, output).toBe(false);
    expect(output).toContain("[null,null]");
    expect(output).toContain("provider-context:absent-a.txt");
    expect(output).toContain("provider-context:absent-b.txt");
    expect(output).not.toContain("private-recovery-fixture");
    expect(getToolResultText(result, "direct")).toContain("provider-context:absent-a.txt");
    const mixed = getToolResultText(result, "mixed");
    expect(getToolExecution(result, "mixed").isError, mixed).toBe(false);
    expect(mixed).toContain("[false,true]");
    expect(mixed).toContain("provider-prefix:a.txt,absent-a.txt");
    expect(mixed).toContain("provider-context:a.txt,absent-a.txt");
    expect(mixed).not.toContain("alpha");
    const replaced = getToolResultText(result, "replaced");
    expect(getToolExecution(result, "replaced").isError, replaced).toBe(false);
    expect(replaced).toContain("provider-context:replace-c.txt");
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
    expect(refused).toContain("RESULT#00000000-0000-4000-8000-000000000000");
    expect(refused).toContain("missing-dir");
    expect(calls(result, "refused")).toMatchObject([
      {
        name: "read",
        status: "error",
        args: { path: "RESULT#00000000-0000-4000-8000-000000000000" },
      },
      { name: "search", status: "ok", args: { path: "a.txt" } },
      { name: "replace", status: "error", args: { path: "a.txt" } },
      { name: "search", status: "error", args: { path: ["a.txt", "missing-dir"] } },
    ]);

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("alpha\n");

    const invalid = getToolResultText(result, "invalid");
    expect(invalid).toContain("rejected:true");
    expect(calls(result, "invalid")).toEqual([
      { name: "search", status: "error", args: { path: "a.txt" } },
    ]);
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
    const lastBlock = getToolResultMessage(result, "partial").content.findLast(
      (block) => block.type === "text",
    )?.text;
    expect(lastBlock).toContain("a.txt");
    expect(lastBlock).toContain("Fixture failed after writing");
    expect(lastBlock).not.toContain("b.txt");
    expect(calls(result, "partial")).toMatchObject([
      { name: "receipt_edit", status: "ok", args: { path: "a.txt" } },
      { name: "receipt_edit", status: "ok", args: { path: "b.txt" } },
      { name: "read", status: "error", args: { path: "a.txt" } },
    ]);
    const details = getToolExecutionDetails(getToolExecution(result, "partial"));
    expect(details).toHaveProperty("editorBatchResults.0.status", "partial");
    expect(details).toHaveProperty("editorBatchResults.0.data.operations.0.effect", "unknown");
    expect(details).toHaveProperty("editorBatchResults.0.data.operations.1.effect", "applied");
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B\n");
    for (const file of ["a.txt", "b.txt"])
      expect(await readFile(path.join(cwd, file + ".writes"), "utf8")).toBe("write\n");
  });
});
