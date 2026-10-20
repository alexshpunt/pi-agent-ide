import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("real Pi audits dedicated Claude-file and seeded Pi rotations without inference", async () => {
  await withTempWorkspace(async (cwd) => {
    await new PiIntegrationTest({
      testName: "capability-claude-file-refresh-registry",
      artifactsDir: testArtifactsDir(import.meta.filename),
      timeoutMs: 120_000,
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("tests/integration/fixtures/capability-claude-file-probe.ts")],
      tools: ["capability_claude_file_probe"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "file-auth-probe",
              name: "capability_claude_file_probe",
              arguments: {},
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Resolve synthetic file-derived OAuth through the public registry without network");
    expect(JSON.parse(await readFile(path.join(cwd, "claude-file-result.json"), "utf8"))).toEqual({
      refreshCalls: 1,
      inferenceCalls: 0,
      firstAuthenticated: true,
      secondAuthenticated: true,
      privateFilePersisted: true,
      seededPiPersisted: true,
      allRotationsRedacted: true,
      originalProviderUnchanged: true,
    });
  });
}, 150_000);
