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

test.each([false, true])(
  "real Pi public registry persists synthetic refresh without re-keying, delegated=%s",
  async (delegated) => {
    await withTempWorkspace(async (cwd) => {
      await new PiIntegrationTest({
        testName: `capability-dedicated-refresh-registry-${delegated ? "delegated" : "native"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        piCommand: process.env.PI_COMMAND ?? "/usr/bin/pi",
        timeoutMs: 120_000,
        cwd,
        isolateUserResources: true,
        extensions: [path.resolve("tests/integration/fixtures/capability-refresh-probe.ts")],
        tools: ["capability_refresh_probe"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "refresh-probe",
                name: "capability_refresh_probe",
                arguments: { delegated },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Resolve synthetic OAuth through the public registry without a network call");
      expect(JSON.parse(await readFile(path.join(cwd, "refresh-result.json"), "utf8"))).toEqual({
        refreshCalls: 1,
        inferenceCalls: 0,
        noCredentialRekey: true,
        authenticated: true,
        persisted: true,
        audited: true,
        originalProviderUnchanged: true,
      });
    });
  },
  150_000,
);
