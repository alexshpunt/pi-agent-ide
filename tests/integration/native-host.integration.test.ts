import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

const installation = process.env.PI_AGENT_IDE_TEST_INSTALLATION;
const entry = installation
  ? path.resolve(installation, "node_modules/pi-agent-ide")
  : path.resolve("src/pi-agent-ide.ts");
const probe = path.resolve("tests/integration/fixtures/native-host-probe.ts");

const root = path.resolve(".tmp/native-host");

test.each([false, true])(
  "isolated Pi loads only explicitly requested native tools (%s)",
  async (native) => {
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      const calls = [
        { id: "host", name: "native_host_probe", arguments: {} },
        ...(native
          ? [
              {
                id: "discover",
                name: "tool_search",
                arguments: { query: "sdk_deferred_probe", limit: 1 },
              },
              { id: "deferred", name: "sdk_deferred_probe", arguments: {} },
              {
                id: "script",
                name: "codemode",
                arguments: { code: "text(await tools.sdk_deferred_probe({}));" },
              },
            ]
          : []),
      ];
      const result = await new PiIntegrationTest({
        testName: `native-host-${installation ? "installed-" : ""}${native}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        extensions: [
          entry,
          probe,
          ...(native ? ["builtin:codemode", "builtin:tool-search", "builtin:mcp"] : []),
        ],
        tools: ["native_host_probe", ...(native ? ["codemode", "tool_search"] : [])],
        isolateUserResources: true,
        conversation: [
          ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
          assistantMessage([text("Done")]),
        ],
      }).run("Verify isolated native tool loading");
      const host = JSON.parse(getToolResultText(result, "host")) as {
        version: string;
        tools: string[];
      };
      expect(host.tools.includes("codemode")).toBe(native);
      expect(host.tools.includes("tool_search")).toBe(native);
      expect(host.tools.some((name) => name.startsWith("mcp__"))).toBe(false);
      for (const call of calls)
        expect(getToolExecution(result, call.id).isError, getToolResultText(result, call.id)).toBe(
          false,
        );
      if (native) {
        expect(getToolResultText(result, "deferred")).toContain("sdk-deferred-marker");
        expect(getToolResultText(result, "script")).toContain("sdk-deferred-marker");
      }
    } finally {
      // The harness awaits PTY tree exit; Windows can release directory locks just after it.
      // Retry removal briefly, but still fail if the workspace remains locked.
      await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
