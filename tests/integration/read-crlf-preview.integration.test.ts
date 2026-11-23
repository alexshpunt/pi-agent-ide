import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";

const fileRows = ["file_value = 42", "print(file_value)"];
const debugRows = ["debug_value = 73", "print(debug_value)"];
const crlfText = (rows: readonly string[]) => `${rows.join("\r\n")}\r\n`;

test("Read previews hide CRLF in files and debugger source without changing results or anchors", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = await createFixture(cwd, "note.py", crlfText(fileRows));
    const program = await createFixture(cwd, "task.py", crlfText(debugRows));
    // No script output: the debugger source lines must come from the native Read panels.
    const code = `const configured = await tools.debug({ adapter: 'debugpy', backend: 'native', program: 'task.py' });
      const session = /debug:[a-f0-9]+/.exec(configured)?.[0];
      if (!session) throw new Error(configured);
      const path = session + '/source';
      try {
        await tools.read({ path });
        const anchored = await tools.read({ path, views: ['anchors'] });
        const anchor = anchored?.text.split('\\n')[1]?.split('|')[0];
        if (!anchor) throw new Error('Missing line anchor');
        await tools.insert({ path, after: anchor, text: 'breakpoint' });
      } finally {
        await tools.delete({ path: session });
      }`;
    const run = await new PiIntegrationTest({
      testName: "crlf-read-previews",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      tuiSize: { cols: 110, rows: 55 },
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/restore-tool-history.ts"),
      ],
      environment: { IDE_HISTORY_EXPANDED: "1" },
      tools: ["debug", "read", "insert", "delete", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({ id: "file", name: "read", arguments: { path: "note.py" } }),
            toolCall({
              id: "file-anchors",
              name: "read",
              arguments: { path: "note.py", views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "debug-source", name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run(
      "Read a CRLF file and a CRLF debugger resource, then place a breakpoint using its line anchor.",
    );

    const action = (id: string) => {
      const execution = getToolExecution(run, id);
      expect(execution.isError, JSON.stringify(execution.result)).toBe(false);
      return execution;
    };
    action("debug-source");
    expect(getToolExecutionDetails(action("debug-source/4"))).toMatchObject({
      metadata: { semanticAction: { file: program, line: 2, verified: false } },
    });

    const payload = (id: string): string => {
      const result = action(id).result as { content: { text: string }[] };
      const modelText = result.content.map((block) => block.text).join("");
      // Read prepends a one-line result reference to this payload.
      return modelText.slice(modelText.indexOf("\n") + 1);
    };
    const preview = run.tuiRenderedOutput.split("\n");
    for (const [plainId, anchoredId, rows] of [
      ["file", "file-anchors", fileRows],
      ["debug-source/2", "debug-source/3", debugRows],
    ] as const) {
      expect(payload(plainId)).toBe(crlfText(rows));
      const anchored = payload(anchoredId);
      expect(anchored.replace(/^[^|\r\n]+\|/gmu, "")).toBe(crlfText(rows));
      const anchoredRows = anchored.split("\r\n");
      for (const [index, row] of rows.entries()) {
        const anchoredRow = anchoredRows[index];
        expect(anchoredRow?.split("|")).toEqual([expect.stringMatching(/^\w+$/u), row]);
        const sourceRows = preview.filter((line) => line.includes(row));
        expect(
          sourceRows.some((line) => line.includes(`│ ${row} `)),
          run.tuiRenderedOutput,
        ).toBe(true);
        expect(
          sourceRows.some((line) => line.includes(`│ ${anchoredRow} `)),
          run.tuiRenderedOutput,
        ).toBe(true);
        expect(
          sourceRows.every((line) => !line.includes("�")),
          sourceRows.join("\n"),
        ).toBe(true);
      }
    }
    expect(await readFile(file)).toEqual(Buffer.from(crlfText(fileRows)));
    expect(await readFile(program)).toEqual(Buffer.from(crlfText(debugRows)));
  });
});
