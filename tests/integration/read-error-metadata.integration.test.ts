import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("Read preserves public failures for direct calls and native scripts without private diagnostics", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "note.txt"), "fixture-kept\n");
    const run = await new PiIntegrationTest({
      testName: "read-public-error-metadata",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/structured-results-fixture.ts"),
      ],
      tools: ["read", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "limited-direct",
              name: "read",
              arguments: { path: "fixture-rate-limited:" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: {
                code: String.raw`
// A failed Read resolves to null; its readable failure is listed in the Codemode result.
const failure = await tools.read({path:"fixture-rate-limited:"});
if(failure !== null) throw Error("Failure contract absent");
const missing = await tools.read({path:"absent.txt"});
if(missing !== null) throw Error("Plain failure contract absent");
const kept = await tools.read({path:"note.txt"});
if(typeof kept?.text !== "string" || !kept.text.includes("fixture-kept")) throw Error("Text success changed");
const image = await tools.read({path:"fixture-image:"});
if(image.type !== "image" || image.mimeType !== "image/png" || typeof image.data !== "string") throw Error("Image success changed");
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect safe Read failures and continue with independent readable resources");
    const direct = getToolResultMessage(run, "limited-direct");
    expect(direct.isError).toBe(true);
    // A failed call has no structured value; its public failure is the readable text.
    expect(
      (getToolExecutionResult(run, "limited-direct") as { structuredContent?: unknown })
        .structuredContent,
    ).toBeUndefined();
    expect(getToolResultText(run, "limited-direct")).toContain("FIXTURE_RATE_LIMITED");
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    const failures = codemodeFailures(getToolResultText(run, "script"));
    expect(failures).toMatch(/^2 of 4 IDE calls failed:\n- read fixture-rate-limited:\n/u);
    expect(failures).toContain("FIXTURE_RATE_LIMITED");
    expect(failures).toContain("- read absent.txt\n");
    for (const id of ["limited-direct", "script"])
      expect(getToolResultText(run, id)).not.toContain("fixture-private-");
  });
});
