import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { PiIntegrationTest } from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";

const canonical = "fixture://saved-canonicalized/content";
const unavailable = "fixture://saved-readback/content";

// Real extension-loader/agent-loop pattern: observe one confirmed save and a separate readback failure.
test.each([
  { mode: "direct", expanded: false },
  { mode: "direct", expanded: true },
  { mode: "codemode", expanded: false },
  { mode: "codemode", expanded: true },
] as const)(
  "confirmed readback outcomes in $mode expanded=$expanded",
  async ({ mode, expanded }) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      await writeFile(path.join(cwd, "saved.md"), "before\n");
      const calls =
        mode === "direct"
          ? [
              toolCall({
                id: "canonical",
                name: "write",
                arguments: { path: canonical, content: "changed\n" },
              }),
              toolCall({ id: "canonical-read", name: "read", arguments: { path: canonical } }),
              toolCall({
                id: "unavailable",
                name: "write",
                arguments: { path: unavailable, content: "updated\n" },
              }),
              toolCall({ id: "fresh-read", name: "read", arguments: { path: unavailable } }),
            ]
          : [
              toolCall({
                id: "chain",
                name: "codemode",
                arguments: {
                  code: `text(await tools.write({path:${JSON.stringify(canonical)},content:"changed\\n"}));\ntext(await tools.read({path:${JSON.stringify(canonical)}}));\ntry { await tools.write({path:${JSON.stringify(unavailable)},content:"updated\\n"}); } catch (error) { text(String(error)); }\ntext(await tools.read({path:${JSON.stringify(unavailable)}}));`,
                },
              }),
            ];
      const run = await new PiIntegrationTest({
        testName: `confirmed-readback-${mode}-${expanded ? "expanded" : "collapsed"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        tuiSize: { cols: 100, rows: 45 },
        environment: {
          WRITE_FAILURE_EXPANDED: expanded ? "1" : "0",
          WRITE_FAILURE_CANONICAL_IDE_SOURCE: path.resolve("."),
        },
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/support/write-saved-mismatch-resource.ts"),
        ],
        tools: ["write", "read", "codemode"],
        conversation: [
          ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
          assistantMessage([text("Confirmed saves inspected without replay.")]),
        ],
      }).run(
        "Read actual canonical saved text and preserve the acknowledged effect when readback fails.",
      );
      if (mode === "direct") {
        expect(getToolExecution(run, "canonical").isError).toBe(false);
        expect(getToolResultText(run, "canonical")).toContain("CHANGED");
        expect(getToolResultText(run, "canonical-read")).toContain("CHANGED");
        expect(getToolExecution(run, "unavailable").isError).toBe(true);
        expect(getToolExecutionDetails(getToolExecution(run, "unavailable"))).toMatchObject({
          effect: "applied",
        });
        expect(getToolResultText(run, "unavailable")).toContain("READBACK");
        expect(getToolResultText(run, "unavailable")).not.toContain("Final text");
        expect(getToolResultText(run, "fresh-read")).toContain("updated");
      } else {
        expect(getToolExecution(run, "chain").isError).toBe(false);
        const result = getToolResultText(run, "chain");
        expect(result).toContain("CHANGED");
        expect(result).toContain("READBACK");
        expect(result).toContain("updated");
      }
      const terminal = run.tuiRenderedOutput.replaceAll(/\s+/gu, " ");
      expect(terminal).toContain("Saved · post-write step failed");
      expect(terminal).not.toContain("Effects unknown");
      expect(await readFile(path.join(cwd, "saved.md"), "utf8")).toBe("updated\n");
      expect(await readFile(path.join(cwd, "attempts.jsonl"), "utf8")).toBe(
        '{"content":"changed\\n"}\n{"content":"updated\\n"}\n',
      );
    });
  },
);
