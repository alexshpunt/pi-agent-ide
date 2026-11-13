import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { expect, test } from "vitest";

const schedules = ["default", "characters", "explicit"] as const;

test.each(schedules)(
  "issued references survive %s argument chunks in separate calls",
  async (schedule) => {
    await withTempWorkspace(async (cwd) => {
      for (const file of ["first.txt", "second.txt"])
        await writeFile(path.join(cwd, file), "before\nOLD\nafter\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
      );
      // The first placeholder crosses the default 1024-code-unit boundary.
      const replacements = ["x".repeat(1000), "y".repeat(1000)];
      const run = await new PiIntegrationTest({
        testName: `issued-reference-chunks-${schedule}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: [
          path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
          path.resolve("src/pi-agent-ide.ts"),
        ],
        tools: ["search", "replace"],
        conversation: [
          assistantMessage(
            ["first", "second"].map((id) =>
              toolCall({
                id: `selection-${id}`,
                name: "search",
                arguments: { path: `${id}.txt`, query: "OLD" },
                delayMs: 0,
              }),
            ),
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            ["first", "second"].map((id, index) => {
              const argumentsJson = JSON.stringify({
                text: replacements[index],
                path: `$issued-uuid:selection-${id}`,
                start: `$issued-searchmatch:selection-${id}:1`,
              });
              const split = argumentsJson.indexOf("selection-") + "selection-".length;
              return toolCall({
                id: `consume-${id}`,
                name: "replace",
                argumentsJson,
                ...(schedule === "characters"
                  ? { chunks: { kind: "characters" as const }, delayMs: 0 }
                  : schedule === "explicit"
                    ? {
                        chunks: {
                          kind: "explicit" as const,
                          chunks: [argumentsJson.slice(0, split), argumentsJson.slice(split)],
                        },
                        delayMs: 0,
                      }
                    : {}),
              });
            }),
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done", { delayMs: 0 })]),
        ],
      }).run("Replace the selected text using references from the preceding Search results");
      for (const [index, id] of ["first", "second"].entries()) {
        expect(
          getToolExecution(run, `consume-${id}`).isError,
          getToolResultText(run, `consume-${id}`),
        ).toBe(false);
        expect(await readFile(path.join(cwd, `${id}.txt`), "utf8")).toBe(
          `before\n${replacements[index]}\nafter\n`,
        );
      }
    });
  },
);
