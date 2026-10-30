import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "./support/pi-runtime/native-pi-coding-agent-test.js";

test("capability loaders hide internal result envelopes in native TUI without removing agent data", async () => {
  await withTempWorkspace(async (cwd) => {
    const agentDir = path.join(cwd, "agent");
    await mkdir(agentDir);
    const result = await new PiIntegrationTest({
      testName: "capability-loader-native-tui",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "tui",
      tuiSize: { cols: 120, rows: 36 },
      tools: ["tool_search"],
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/deferred-capabilities.ts"),
        "builtin:tool-search",
      ],
      environment: { PI_CODING_AGENT_DIR: agentDir },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "discover",
              name: "tool_search",
              arguments: { query: "ide_capability_alpha", limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([toolCall({ id: "load", name: "ide_capability_alpha", arguments: {} })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Discover and enable the fixture capability");

    expect(getToolExecution(result, "load")).toMatchObject({
      isError: false,
      result: { details: { capability: "fixture.alpha" } },
    });
    const agentText = getToolResultText(result, "load");
    expect(agentText).toContain("fixture.alpha");
    expect(agentText).toMatch(
      /^<system-result\b[^>]*><uuid>[a-f\d-]{36}<\/uuid><\/system-result>\n/u,
    );
    expect(result.tuiRenderedOutput).toContain("fixture.alpha");
    expect(result.tuiRenderedOutput).not.toContain("<system-result");
    expect(result.tuiRenderedOutput).not.toContain("<uuid>");
  });
});
