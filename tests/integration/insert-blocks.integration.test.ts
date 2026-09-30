import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extension = path.resolve("src/pi-agent-ide.ts");

for (const [name, original, payload, mode, expected] of [
  ["unterminated EOF", "anchor", "new\n\n", "line", "anchor\nnew\n\n"],
  ["LF block", "A\nB\n", "X", "blank-line", "A\n\nX\n\nB\n"],
  ["existing LF separator", "A\n\nB\n", "X", "blank-line", "A\n\nX\n\nB\n"],
  ["CRLF block", "A\r\nB\r\n", "X", "blank-line", "A\r\n\r\nX\r\n\r\nB\r\n"],
  ["existing CRLF separator", "A\r\n\r\nB\r\n", "X", "blank-line", "A\r\n\r\nX\r\n\r\nB\r\n"],
] as const) {
  test(`real Pi insert and linewise Apply agree: ${name}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "standalone.txt"), original);
      await writeFile(path.join(cwd, "apply.txt"), original);
      const run = await new PiIntegrationTest({
        testName: `insert-block-${name.replaceAll(" ", "-")}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [extension],
        tools: ["read", "insert", "apply"],
        conversation: [
          assistantMessage(
            [
              toolCall({ id: "editing-guide", name: "read", arguments: { path: "docs:editing" } }),
              toolCall({ id: "apply-guide", name: "read", arguments: { path: "docs:apply" } }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "insert",
                name: "insert",
                arguments: {
                  path: "standalone.txt",
                  anchor: original.startsWith("anchor") ? "anchor" : "A",
                  text: payload,
                  separation: mode,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "apply",
                name: "apply",
                arguments: {
                  source: `const file = open("apply.txt"); file.insertAfter(file.line(1), ${JSON.stringify(payload)}, { separation: ${JSON.stringify(mode)} });`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Insert the supplied text into both files.");
      expect(getToolExecution(run, "insert").isError, getToolResultText(run, "insert")).toBe(false);
      expect(getToolExecution(run, "apply").isError).toBe(false);
      expect(await readFile(path.join(cwd, "standalone.txt"), "utf8")).toBe(expected);
      expect(await readFile(path.join(cwd, "apply.txt"), "utf8")).toBe(expected);
    });
  }, 120_000);
}

test("real Pi rejects empty insert without changing EOF bytes", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "standalone.txt"), "anchor");
    await writeFile(path.join(cwd, "apply.txt"), "anchor");
    const run = await new PiIntegrationTest({
      testName: "insert-empty-payload",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [extension],
      tools: ["read", "insert", "apply"],
      conversation: [
        assistantMessage(
          [
            toolCall({ id: "editing-guide", name: "read", arguments: { path: "docs:editing" } }),
            toolCall({ id: "apply-guide", name: "read", arguments: { path: "docs:apply" } }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "insert",
              name: "insert",
              arguments: { path: "standalone.txt", anchor: "anchor", text: "" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "apply",
              name: "apply",
              arguments: {
                source: 'const file = open("apply.txt"); file.insertAfter(file.line(1), "");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Try an empty insertion in both files.");
    expect(getToolExecution(run, "insert").isError).toBe(true);
    expect(getToolExecution(run, "apply").isError).toBe(true);
    expect(await readFile(path.join(cwd, "standalone.txt"), "utf8")).toBe("anchor");
    expect(await readFile(path.join(cwd, "apply.txt"), "utf8")).toBe("anchor");
  });
}, 120_000);
