import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";

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

const file = "shared.txt";
const chunks = { kind: "fixed", size: Number.MAX_SAFE_INTEGER } as const;
const recordBudget = 128 * 1024;
const untouched = "UNTOUCHED-SNAPSHOT-SENTINEL";

function fixture(lineCount: number) {
  const lines = Array.from(
    { length: lineCount },
    (_, index) =>
      `${String(index + 1).padStart(5, "0")} ${index < 80 || index >= lineCount - 10 ? "edit fixture" : untouched} ${".".repeat(30)}`,
  );
  const source = `${lines.join("\n")}\n`;
  const anchor = (line: number) => formatLineHashAnchor(source, line);
  const edits = Array.from({ length: 12 }, (_, index) => {
    const line = 3 + index * 4;
    return index % 2 === 0
      ? // A line anchor selects the line with its line break; the text keeps it.
        {
          name: "replace",
          args: { path: file, start: anchor(line), newText: `replacement-${line}\n` },
        }
      : { name: "delete", args: { path: file, start: anchor(line) } };
  });
  const expected = [...lines];
  expected.splice(75, 0, requiredValue(lines[59]));
  expected.splice(65, 0, "inserted");
  expected.splice(59, 1);
  for (let index = 11; index >= 0; index--) {
    const line = 3 + index * 4;
    expected.splice(line - 1, 1, ...(index % 2 === 0 ? [`replacement-${line}`] : []));
  }
  return {
    source,
    expected: `${expected.join("\n")}\n`,
    edits: [
      ...edits,
      { name: "insert", args: { path: file, anchor: anchor(65), newText: "inserted" } },
      { name: "move", args: { path: file, start: anchor(60), targetStart: anchor(75) } },
      { name: "write", args: { path: "written.txt", content: "small" } },
    ],
  };
}

test.each(["direct", "direct without renderer", "codemode"])(
  "bounds edit RPC records on a large shared file via %s",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      const { source, expected, edits } = fixture(route === "codemode" ? 24_000 : 2_000);
      if (route === "codemode") expect(Buffer.byteLength(source)).toBeGreaterThan(1024 * 1024);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          disabled: [
            "ide.lsp",
            "ide.lint",
            ...(route === "direct without renderer" ? ["editor.renderer"] : []),
          ],
        }),
      );
      await writeFile(path.join(cwd, file), source);
      const calls =
        route !== "codemode"
          ? edits.map(({ name, args }, index) =>
              toolCall({ name, id: `edit-${index}`, arguments: args, chunks }),
            )
          : [
              toolCall({
                name: "codemode",
                id: "script",
                arguments: {
                  code: `await Promise.all([${edits.map(({ name, args }) => `tools.${name}(${JSON.stringify(args)})`).join(",")}]);`,
                },
                chunks,
              }),
            ];
      const run = await new PiIntegrationTest({
        testName: `bounded-edit-events-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        transport: "rpc",
        traceToolDetails: false,
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["replace", "delete", "insert", "move", "write", "codemode"],
        conversation: [
          assistantMessage(calls, { stopReason: "toolUse" }),
          assistantMessage([text("Done", { chunks })]),
        ],
      }).run("Edit the shared file and write the receipt file");

      const updates: string[] = [];
      const ends = new Map<
        string,
        { isError?: boolean; result?: { details?: { editorBatches?: { calls: unknown[] }[] } } }
      >();
      for (const line of run.terminalOutput.split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as {
          type: string;
          toolName?: string;
          toolCallId?: string;
          isError?: boolean;
          result?: { details?: { editorBatches?: { calls: unknown[] }[] } };
        };
        if (record.type !== "tool_execution_update" && record.type !== "tool_execution_end")
          continue;
        const label = `${record.type} ${record.toolName} (${record.toolCallId})`;
        expect(Buffer.byteLength(line), label).toBeLessThanOrEqual(recordBudget);
        expect(line.includes(untouched), label).toBe(false);
        if (record.type === "tool_execution_update") updates.push(label);
        else if (record.toolCallId !== undefined) ends.set(record.toolCallId, record);
      }
      expect(updates.length).toBeGreaterThan(0);
      if (route === "codemode") {
        expect(
          ends
            .get("script")
            ?.result?.details?.editorBatches?.some(({ calls }) => calls.length >= 12),
        ).toBe(true);
        for (let index = 1; index <= edits.length; index++) {
          expect(ends.get(`script/${index}`)?.isError, `nested edit ${index}`).toBe(false);
        }
      }
      for (const call of calls) {
        expect(ends.has(call.id)).toBe(true);
        expect(getToolExecution(run, call.id).isError, getToolResultText(run, call.id)).toBe(false);
      }
      const actual = (await readFile(path.join(cwd, file), "utf8")).split("\n");
      const expectedLines = expected.split("\n");
      const mismatch = expectedLines.findIndex((line, index) => line !== actual[index]);
      expect(
        mismatch,
        `line ${mismatch + 1}: got ${actual[mismatch]}, expected ${expectedLines[mismatch]}`,
      ).toBe(-1);
      expect(actual.length).toBe(expectedLines.length);
      await expect(readFile(path.join(cwd, "written.txt"), "utf8")).resolves.toBe("small");
    });
  },
  60_000,
);
