import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { NO_FINAL_LINE_BREAK } from "pi-agent-text";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const MARKER = NO_FINAL_LINE_BREAK;
const ANCHOR_PREFIX = /^[0-9A-HJKMNP-TV-Z]{7}\|/u;

interface Step {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

async function run(cwd: string, steps: readonly Step[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
  return new PiIntegrationTest({
    cwd,
    testName: "end-of-file-marker",
    artifactsDir: testArtifactsDir(import.meta.filename),
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["read", "replace", "insert"],
    rawMode: false,
    tuiSize: { cols: 160, rows: 180 },
    conversation: [
      ...steps.map((step) =>
        assistantMessage([toolCall({ id: step.id, name: step.tool, arguments: step.args })], {
          stopReason: "toolUse",
        }),
      ),
      assistantMessage([text("Finished.")]),
    ],
  }).run("Run each requested call in order.");
}

const FILES: Readonly<Record<string, string>> = {
  "lf-open.txt": "one\ntwo\nthree",
  "lf-closed.txt": "one\ntwo\nthree\n",
  "crlf-open.txt": "one\r\ntwo\r\nthree",
  "crlf-closed.txt": "one\r\ntwo\r\nthree\r\n",
  "bom-open.txt": "\uFEFFone\ntwo\nthree",
  "bom-closed.txt": "\uFEFFone\ntwo\nthree\n",
  "empty.txt": "",
};

test("Read shows the marker only after the last line of a file without a final line break", async () => {
  await withTempWorkspace(async (cwd) => {
    const steps: Step[] = [];
    for (const [file, content] of Object.entries(FILES)) {
      await writeFile(path.join(cwd, file), content);
      steps.push(
        { id: `plain:${file}`, tool: "read", args: { path: file } },
        { id: `anchors:${file}`, tool: "read", args: { path: file, views: ["anchors"] } },
      );
    }
    steps.push(
      { id: "tail", tool: "read", args: { path: "lf-open.txt", offset: 2, views: ["anchors"] } },
      { id: "head", tool: "read", args: { path: "lf-open.txt", limit: 2, views: ["anchors"] } },
    );
    const result = await run(cwd, steps);

    for (const [file, content] of Object.entries(FILES)) {
      const open = content.length > 0 && !content.endsWith("\n");
      const plain = getToolResultText(result, `plain:${file}`).split("\n");
      const anchored = getToolResultText(result, `anchors:${file}`).split("\n");
      expect(plain.includes(MARKER), file).toBe(open);
      expect(anchored.includes(MARKER), file).toBe(open);
      if (!open) continue;
      expect(plain.at(-1), file).toBe(MARKER);
      expect(anchored.at(-1), file).toBe(MARKER);
      // The marker is no line: the three file lines carry anchors, the marker none.
      expect(
        anchored.slice(0, 3).every((line) => ANCHOR_PREFIX.test(line)),
        file,
      ).toBe(true);
      expect(anchored).toHaveLength(4);
    }
    const tail = getToolResultText(result, "tail").split("\n");
    expect(tail).toHaveLength(3);
    expect(tail.at(-1)).toBe(MARKER);
    expect(getToolResultText(result, "head").split("\n")).not.toContain(MARKER);
  });
});

test.each([
  ["replace", { start: "two" }, `changed\n${MARKER}`],
  ["replace", { start: "two" }, MARKER],
  ["replace", { start: "two" }, `changed\r\n${MARKER}\r\n`],
  ["insert", { anchor: "two" }, `added\n${MARKER}`],
] as const)(
  "%s refuses text whose last line is the marker and leaves the file as it is",
  async (tool, selector, content) => {
    await withTempWorkspace(async (cwd) => {
      const initial = "one\ntwo\nthree";
      await writeFile(path.join(cwd, "target.txt"), initial);
      const result = await run(cwd, [
        { id: "refused", tool, args: { path: "target.txt", ...selector, text: content } },
      ]);
      expect(getToolExecution(result, "refused").isError).toBe(true);
      expect(getToolExecutionDetails(getToolExecution(result, "refused"))).toMatchObject({
        effect: "not-applied",
        results: [{ data: { errors: [{ code: "END_OF_FILE_MARKER" }] } }],
      });
      expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(initial);
    });
  },
);

test("text that only mentions the marker in the middle is written as given", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "target.txt"), "one\ntwo\nthree");
    const result = await run(cwd, [
      {
        id: "middle",
        tool: "replace",
        args: { path: "target.txt", start: "two", text: `${MARKER}\ntwo` },
      },
      {
        id: "inline",
        tool: "replace",
        args: { path: "target.txt", start: "three", text: `see ${MARKER}` },
      },
    ]);
    expect(getToolExecution(result, "middle").isError).not.toBe(true);
    expect(getToolExecution(result, "inline").isError).not.toBe(true);
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
      `one\n${MARKER}\ntwo\nsee ${MARKER}`,
    );
  });
});
