import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

test("empty replacements remove lines and keep unselected separators in real Pi", async () => {
  const root = path.resolve(".agents/tmp/empty-replace");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  const cases = [
    { content: "A\nSTART\nmiddle\nEND\n\nB\n", start: "START", end: "END", expected: "A\n\nB\n" },
    {
      content: "A\r\nSTART\r\nmiddle\r\nEND\r\n\r\nB\r\n",
      start: "START",
      end: "END",
      expected: "A\r\n\r\nB\r\n",
    },
    { content: "A\nBLOCK", start: "end", expected: "A" },
    { content: "BLOCK\n", start: "begin", expected: "" },
    { content: "A BLOCK B\n", start: "BLOCK", expected: "A  B\n" },
  ];
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ noAnimations: true, noPostProcessing: true }),
    );
    for (const [i, item] of cases.entries())
      await writeFile(path.join(cwd, `${i}.txt`), item.content);
    const result = await new PiIntegrationTest({
      testName: "empty-replace",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          cases.map((item, i) =>
            toolCall({
              id: `replace-${i}`,
              name: "replace",
              arguments: {
                path: `${i}.txt`,
                start: item.start,
                ...(item.end === undefined ? {} : { end: item.end }),
                text: "",
              },
            }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply the supplied edits.");
    for (const [i, item] of cases.entries()) {
      expect(getToolExecution(result, `replace-${i}`).isError).toBe(false);
      expect(await readFile(path.join(cwd, `${i}.txt`), "utf8")).toBe(item.expected);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
