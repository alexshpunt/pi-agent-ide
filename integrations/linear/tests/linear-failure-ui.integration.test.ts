import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const linearSource = "linear://example/document/90000000-0000-4000-8000-000000000746/content";

test.each([
  { mode: "direct", expanded: false, generic: false },
  { mode: "direct", expanded: true, generic: false },
  { mode: "codemode", expanded: false, generic: false },
  { mode: "codemode", expanded: true, generic: false },
  { mode: "direct", expanded: false, generic: true },
] as const)(
  "Failure reason and safe recovery in $mode expanded=$expanded generic=$generic",
  async ({ mode, expanded, generic }) => {
    const source = generic ? "fixture://linear-failure-proof/content" : linearSource;
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/linear-failure-ui-"));
    try {
      const call =
        mode === "direct"
          ? toolCall({
              id: "failed",
              name: "write",
              arguments: { path: source, content: "Changed once" },
            })
          : toolCall({
              id: "failed",
              name: "codemode",
              arguments: {
                code: `try { await tools.write({path:${JSON.stringify(source)},content:"Changed once"}); } catch(error) { text(String(error)); }`,
              },
            });
      const result = await new PiIntegrationTest({
        testName: `${generic ? "generic" : "linear"}-failure-${mode}-${expanded ? "expanded" : "collapsed"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        tuiSize: { cols: 60, rows: 40 },
        timeoutMs: 60000,
        environment: { LINEAR_FAILURE_EXPANDED: expanded ? "1" : "0" },
        // Normal sessions can load the provider before IDE; its panel must not hide the shared fallback.
        extensions: [
          path.join(root, "src/index.ts"),
          ide.extension,
          "builtin:codemode",
          path.join(root, "tests/fixtures/linear-failure-ui.ts"),
        ],
        tools: ["write", "read", "codemode"],
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage(
            [toolCall({ id: "recovered", name: "read", arguments: { path: source } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Read the saved content; did not replay the write.")]),
        ],
      }).run("Observe the uncertain save and read its actual content before deciding what to do.");
      await ide.record(result.artifacts.directory);
      expect(getToolExecution(result, "failed").isError).toBe(mode === "direct");
      expect(getToolResultText(result, "failed")).toContain(
        generic ? "PROVIDER_SAVE_VERIFICATION_FAILED" : "LINEAR_AXI_FAILED",
      );
      expect(getToolResultText(result, "recovered")).toContain("Lost content");
      if (mode === "direct")
        expect(getToolExecutionDetails(getToolExecution(result, "failed"))).toMatchObject({
          effect: "unknown",
        });
      const shown = result.tuiRenderedOutput.replaceAll(/\s+/gu, " ");
      expect(shown).toContain("Effects unknown · edit failed");
      expect(shown).toContain(
        generic ? "Reason: resource write failed" : "Reason: The Linear request failed.",
      );
      expect(shown).toContain("Read the affected resource before retrying.");
      const proof = generic ? ".tmp/generic-failure-proof" : ".tmp/linear-failure-proof";
      expect(await readFile(path.join(cwd, proof, "attempts.log"), "utf8")).toBe("write\n");
      expect(await readFile(path.join(cwd, proof, "saved.md"), "utf8")).toBe("Lost content");
      expect(result.terminalOutput).not.toContain("\x1b[3J");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);
