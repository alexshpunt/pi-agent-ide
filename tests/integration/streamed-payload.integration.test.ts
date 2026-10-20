import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutions,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { expect, test } from "vitest";

test("a bounded repeated edit payload completes through real Pi argument streaming", async () => {
  await withTempWorkspace(async (cwd) => {
    const payload = "STREAM-PAYLOAD-LINE\n".repeat(192).trimEnd();
    await writeFile(path.join(cwd, "note.txt"), "keep\nOLD\nlast\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
    );
    const args = JSON.stringify({ path: "note.txt", start: "OLD", text: payload });
    const chunks = Array.from({ length: Math.ceil(args.length / 8) }, (_, index) =>
      args.slice(index * 8, index * 8 + 8),
    );
    const run = await new PiIntegrationTest({
      testName: "streamed-repeated-edit-payload",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 90_000,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "streamed-edit",
              name: "replace",
              argumentsJson: args,
              chunks: { kind: "explicit", chunks },
              delayMs: 1,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply the complete bounded literal payload");
    expect(getToolExecution(run, "streamed-edit").isError).toBe(false);
    expect(
      getToolExecutions(run).filter((call) => call.toolCallId === "streamed-edit"),
    ).toHaveLength(1);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(`keep\n${payload}\nlast\n`);
  });
}, 120_000);
