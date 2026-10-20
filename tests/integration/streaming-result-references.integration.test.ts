import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { expect, test } from "vitest";

const cases = [
  {
    name: "fresh-path-and-anchor",
    source: "note.txt",
    anchor: "start",
    stale: false,
    error: false,
    payload: "OLD\nADDED",
    after: "keep\nOLD\nADDED\nlast\n",
  },
  {
    name: "stale-result-and-anchor",
    source: "$issued-uuid:selection",
    anchor: "start",
    stale: true,
    error: true,
    payload: "NEW",
    after: "keep\nCHANGED\nlast\n",
  },
  {
    name: "replace-with-start",
    source: "$issued-uuid:selection",
    anchor: "start",
    stale: false,
    error: true,
    payload: "NEW",
    after: "keep\nOLD\nlast\n",
  },
  {
    name: "replace-selected-result",
    source: "$issued-uuid:selection",
    anchor: undefined,
    stale: false,
    error: false,
    payload: "OLD\nADDED",
    after: "keep\nOLD\nADDED\nlast\n",
  },
] as const;

test.each(cases)(
  "streamed $name preserves issued-result authority before text arrives",
  async (entry) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "keep\nOLD\nlast\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
      );
      const prefix =
        `{"path":${JSON.stringify(entry.source)}` +
        (entry.anchor ? `,"${entry.anchor}":"$issued-searchmatch:selection:1"` : "");
      const payload = `,"text":${JSON.stringify(entry.payload)}}`;
      const run = await new PiIntegrationTest({
        testName: `streamed-outer-search-${entry.name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        timeoutMs: 120_000,
        extensions: [
          path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
          path.resolve("src/pi-agent-ide.ts"),
        ],
        tools: ["search", "replace", "insert"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "selection",
                name: "search",
                arguments: { path: "note.txt", query: "OLD" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          ...(entry.stale
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "change",
                      name: "replace",
                      arguments: { path: "note.txt", start: "OLD", text: "CHANGED" },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]
            : []),
          assistantMessage(
            [
              toolCall({
                id: "consume",
                name: "replace",
                argumentsJson: prefix + payload,
                chunks: { kind: "explicit", chunks: [prefix, payload] },
                delayMs: 1,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Consume the actual Search result while streaming the next tool arguments");
      expect(getToolExecution(run, "selection").isError).toBe(false);
      expect(getToolExecution(run, "consume").isError, getToolResultText(run, "consume")).toBe(
        entry.error,
      );
      expect(
        getToolExecutions(run).filter((execution) => execution.toolCallId === "consume"),
      ).toHaveLength(1);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(entry.after);
      if (entry.name === "replace-with-start") {
        expect(getToolResultText(run, "consume")).toContain("RESULT_INPUT_REJECTED");
        expect(getToolResultText(run, "consume")).not.toContain("ENOENT");
      }
    });
  },
);
