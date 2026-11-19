import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lineAnchors, textLineAnchors } from "pi-agent-text";
import { expect, onTestFinished, test } from "vitest";

import { readTextFile } from "./ast/read-text.ts";
import { createAstSearchPresentation } from "./search-presentation.ts";

// Only LF ends a line. CR, a lone CR and a BOM are ordinary characters of their line.
const content = "\uFEFFconst a = 1;\r\nconst b = 'x\ry';\nconst c = 3;\r\n";

test("outline snapshots keep every CR, so their line anchors are the editor's", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-ast-line-breaks-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  await writeFile(source, content);

  const snapshot = await readTextFile(source);

  expect(snapshot.content).toBe(content);
  expect(snapshot.lines).toEqual(["\uFEFFconst a = 1;\r", "const b = 'x\ry';", "const c = 3;\r"]);
  expect(lineAnchors(snapshot.lines)).toEqual(textLineAnchors(source, content));
});

test("search presentation keeps a CR in its line, so highlights stay on the matched text", () => {
  const details = createAstSearchPresentation(
    "y",
    [
      {
        file: "note.ts",
        lines: "const b = 'x\ry';\n",
        range: { start: { line: 1, column: 13 }, end: { line: 1, column: 14 } },
      },
    ],
    true,
    "/workspace",
    "AAAA",
  );

  const [line] = details.files[0]?.lines ?? [];
  expect(line?.lineNumber).toBe(2);
  expect(line?.text).toBe("const b = 'x\ry';");
  expect(line?.text.slice(line.ranges[0]?.from, line.ranges[0]?.to)).toBe("y");
});
