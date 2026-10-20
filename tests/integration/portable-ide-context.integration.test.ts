import path from "node:path";
import {
  assistantMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { expect, test } from "vitest";

test("IDE preserves structured provider context instead of forcing an opaque prompt", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "portable-ide-provider-context",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 90_000,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/portable-context-probe.ts"),
      ],
      tools: ["portable_context_probe"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "probe", name: "portable_context_probe", arguments: {} })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect the provider's context representation");
    expect(JSON.parse(getToolResultText(run, "probe"))).toEqual({
      opaque: false,
      fixture: "transport-fixture-value",
    });
  });
});
