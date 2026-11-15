import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const scenarios = ["single", "batch", "mixed", "insert", "wrong-file"] as const;
for (const operation of ["copy", "move"] as const) {
  test.each(scenarios)(
    `${operation} resolves issued destination objects (%s)`,
    async (scenario) => {
      await withTempWorkspace(async (cwd) => {
        const source = "before COPY_BEGIN body COPY_END after\n";
        const target = "left TARGET_BEGIN old TARGET_END right\n";
        await writeFile(path.join(cwd, "source.txt"), source);
        await writeFile(path.join(cwd, "peer-source.txt"), "peer\n");
        await writeFile(path.join(cwd, "peer.txt"), "ANCHOR\n");
        await writeFile(path.join(cwd, "target.txt"), target);
        await writeFile(path.join(cwd, "other.txt"), target);
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
          JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
        );
        const transfer = toolCall({
          id: "transfer",
          name: operation,
          arguments: {
            path: "source.txt",
            start: "COPY_BEGIN",
            end: "COPY_END",
            target: "target.txt",
            targetStart: { id: "$issued-searchmatch:begin:1" },
            ...(scenario !== "insert" && {
              targetEnd: scenario === "mixed" ? "TARGET_END" : { id: "$issued-searchmatch:end:1" },
            }),
          },
          delayMs: 0,
        });
        const peer = toolCall({
          id: "peer",
          name: "copy",
          arguments: {
            path: "peer-source.txt",
            start: "peer",
            target: "peer.txt",
            targetStart: "ANCHOR",
          },
          delayMs: 0,
        });
        const result = await new PiIntegrationTest({
          testName: `${operation}-search-object-destination-${scenario}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          rawMode: false,
          extensions: [
            path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
            path.resolve("src/pi-agent-ide.ts"),
          ],
          tools: ["search", "copy", "move"],
          conversation: [
            ...["begin", "end"].map((id) =>
              assistantMessage(
                [
                  toolCall({
                    id,
                    name: "search",
                    arguments: {
                      path: scenario === "wrong-file" ? "other.txt" : "target.txt",
                      query: id === "begin" ? "TARGET_BEGIN" : "TARGET_END",
                    },
                    delayMs: 0,
                  }),
                ],
                { stopReason: "toolUse" },
              ),
            ),
            assistantMessage(scenario === "single" ? [transfer] : [transfer, peer], {
              stopReason: "toolUse",
            }),
            assistantMessage([text("Done", { delayMs: 0 })]),
          ],
        }).run("Transfer the selected text using the issued destination references.");
        const failed = scenario === "wrong-file";
        expect(
          getToolExecution(result, "transfer").isError,
          getToolResultText(result, "transfer"),
        ).toBe(failed);
        expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
          failed
            ? target
            : scenario === "insert"
              ? "left TARGET_BEGINCOPY_BEGIN body COPY_END old TARGET_END right\n"
              : "left COPY_BEGIN body COPY_END right\n",
        );
        expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe(
          operation === "copy" || failed ? source : "before  after\n",
        );
        expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe(target);
        if (scenario !== "single") {
          expect(getToolExecution(result, "peer").isError, getToolResultText(result, "peer")).toBe(
            false,
          );
          expect(await readFile(path.join(cwd, "peer.txt"), "utf8")).toBe("ANCHOR\npeer\n");
        }
        if (failed) {
          expect(getToolResultText(result, "transfer")).toContain("targetStart");
          expect(getToolResultText(result, "transfer")).toContain("target.txt");
          const receipt = getToolResultMessage<{
            effect: string;
            metadata?: { targetUnavailable?: string };
          }>(result, "transfer");
          expect(receipt.details.effect).toBe("not-applied");
          expect(receipt.details.metadata?.targetUnavailable).toBeUndefined();
        }
      });
    },
  );
}
