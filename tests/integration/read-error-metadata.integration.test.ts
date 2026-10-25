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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

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
const failure = await tools.read({path:"fixture-rate-limited:"});
if(failure.status !== "error" || failure.errors.length !== 1) throw Error("Failure contract absent");
const error = failure.errors[0];
if(error.code !== "FIXTURE_RATE_LIMITED" || error.source !== "fixture-rate-limited:") throw Error("Failure identity lost");
const expected = {rateLimit:{retryAfterMs:1250,resetAt:2000000000000,requestsRemaining:0,endpoint:"core"}};
if(JSON.stringify(error.metadata) !== JSON.stringify(expected)) throw Error("Metadata changed");
if(Object.keys(failure).sort().join(",") !== "errors,status" || Object.keys(error).sort().join(",") !== "code,message,metadata,source") throw Error("Private fields leaked");
text(failure);
const missing = await tools.read({path:"absent.txt"});
if(missing.status !== "error" || !missing.errors.length || missing.errors[0].metadata !== undefined) throw Error("Plain failure contract absent");
const kept = await tools.read({path:"note.txt"});
if(typeof kept !== "string" || !kept.includes("fixture-kept")) throw Error("Text success changed");
const image = await tools.read({path:"fixture-image:"});
if(image.type !== "image" || image.mimeType !== "image/png" || typeof image.data !== "string" || typeof image.note !== "string") throw Error("Image success changed");
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
    expect(getToolExecutionResult(run, "limited-direct")).toMatchObject({
      structuredContent: {
        status: "error",
        errors: [
          {
            code: "FIXTURE_RATE_LIMITED",
            message: expect.any(String) as unknown,
            source: "fixture-rate-limited:",
            metadata: {
              rateLimit: {
                retryAfterMs: 1250,
                resetAt: 2_000_000_000_000,
                requestsRemaining: 0,
                endpoint: "core",
              },
            },
          },
        ],
      },
    });
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    for (const id of ["limited-direct", "script"])
      expect(getToolResultText(run, id)).not.toContain("fixture-private-");
  });
});
