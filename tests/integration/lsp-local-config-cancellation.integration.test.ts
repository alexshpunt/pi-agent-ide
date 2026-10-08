import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("loaded local config cancellation preserves its reason and ordinary symbols work after retry", async () => {
  const base = path.resolve(".tmp/lsp-local-config");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "owned-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: ["ide.ast", "ide.formatter", "ide.lint", "ide.debugger", "ide.vision"],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "local-lsp-config-cancellation",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/lsp-local-config-live.ts"),
      ],
      tools: ["search"],
      conversation: [
        assistantMessage([
          toolCall({
            id: "retry-symbols",
            name: "search",
            arguments: { query: "symbols:label", path: cwd, include: "*.ts" },
          }),
        ]),
        assistantMessage([text("The owned local registry recovered.")]),
      ],
    }).run("Find label in this project after its local registry cancellation check.");
    const proof: unknown = JSON.parse(
      await readFile(path.join(cwd, "local-config-proof.json"), "utf8"),
    );
    expect(proof).toEqual({
      project: cwd,
      cancellationRetained: true,
      retrySelectedOwnedServer: true,
      discovery: {
        projectDiscoveryRetained: true,
        executableCheckRetained: true,
        runtimeEvidenceRetained: true,
        manifestReadRetained: true,
      },
    });
    expect(getToolExecution(run, "retry-symbols").isError).toBe(false);
    expect(getToolResultText(run, "retry-symbols")).toContain("note.ts:1:7 14 label");
    expect(run.tuiRenderedOutput).toContain("label");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 45000);
