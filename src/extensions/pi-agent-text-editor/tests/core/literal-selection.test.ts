import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { TextAnchor } from "pi-agent-text";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import type { TextMutationContext } from "#src/api/mutation-tool.ts";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.ts";
import { copyMutationTool } from "#src/tools/tool-text-copy.ts";
import { deleteMutationTool } from "#src/tools/tool-text-delete.ts";
import { insertMutationTool } from "#src/tools/tool-text-insert.ts";
import { moveMutationTool } from "#src/tools/tool-text-move.ts";
import { replaceMutationTool } from "#src/tools/tool-text-replace.ts";

/** A line anchor, such as a Read line hash or a `SEARCH#…:N:line` reference. */
class Line extends TextAnchor {
  constructor(line: number) {
    super("line", line);
  }
}

/**
 * Runs one mutation on `source` (and `target` for transfers). A string selector resolves as
 * literal text through the exact-text resolver; a number selects that line.
 */
async function run(
  tool: { mutate: (context: TextMutationContext, parameters: never) => unknown },
  contents: Readonly<Record<string, string>>,
  selectors: Readonly<Record<string, string | number>>,
  parameters: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, string>> {
  const documents = new Map(
    Object.entries(contents).map(([source, content]) => [source, new TextChangeDocument(content)]),
  );
  const documentFor = (source: string) => requiredValue(documents.get(source));
  const fileOf = (field: string) => (field.startsWith("target") ? "target" : "source");
  const resolve = (field: string) => {
    const value = selectors[field];
    if (value === undefined) throw new Error(`Missing selector ${field}`);
    const source = fileOf(field);
    if (typeof value === "number") return new Map([[source, new Line(value)]]);
    const content = documentFor(source).content;
    const resolved = resolveExactTextAnchor(value, {
      source,
      content,
      lines: content.split(/\r\n|\r|\n/u),
      cwd: process.cwd(),
    });
    if (resolved.kind !== "resolved") throw new Error(`Selector ${field} did not resolve`);
    return new Map([[source, resolved.anchor]]);
  };
  const context: TextMutationContext = {
    cwd: process.cwd(),
    sourceDocument: documentFor("source"),
    documentFor,
    sourceFor: fileOf,
    targetDocument: () => documentFor("target"),
    resolveAnchors: async (field) => resolve(field),
    resolveAnchor: async (field) => requiredValue(resolve(field).values().next().value),
  };
  const result = (await tool.mutate(context, { ...selectors, ...parameters } as never)) as {
    edits: ReadonlyMap<
      string,
      { changes: readonly { from: number; to: number; insert: string }[] }
    >;
  };
  return Object.fromEntries(
    Object.entries(contents).map(([source, content]) => {
      const edit = result.edits.get(source);
      return [
        source,
        edit === undefined ? content : applyTextChanges(content, edit.changes).content,
      ];
    }),
  );
}

const file = "// PREFIX\n// BEGIN block\nbody line\n// END block\n// SUFFIX\n";

test("insert after a literal that covers a whole line adds the text right after it", async () => {
  expect(
    await run(
      insertMutationTool,
      { source: file },
      { anchor: "// END block" },
      { newText: "// X" },
    ),
  ).toEqual({ source: file.replace("// END block", "// END block// X") });
});

test("insert before a literal that covers a whole line adds the text right before it", async () => {
  expect(
    await run(
      insertMutationTool,
      { source: file },
      { anchor: "// END block" },
      { newText: "// X", before: true },
    ),
  ).toEqual({ source: file.replace("// END block", "// X// END block") });
});

test("insert after a line anchor still puts the text on its own line", async () => {
  expect(
    await run(insertMutationTool, { source: file }, { anchor: 4 }, { newText: "// X" }),
  ).toEqual({
    source: file.replace("// END block\n", "// END block\n// X\n"),
  });
});

test("delete of a literal that covers a whole line keeps its line break", async () => {
  expect(await run(deleteMutationTool, { source: file }, { start: "body line" })).toEqual({
    source: "// PREFIX\n// BEGIN block\n\n// END block\n// SUFFIX\n",
  });
});

test("delete between two whole-line literals keeps the line break after the end", async () => {
  expect(
    await run(
      deleteMutationTool,
      { source: file },
      { start: "// BEGIN block", end: "// END block" },
    ),
  ).toEqual({ source: "// PREFIX\n\n// SUFFIX\n" });
});

test("delete of a line anchor still removes the line with its break", async () => {
  expect(await run(deleteMutationTool, { source: file }, { start: 3 })).toEqual({
    source: "// PREFIX\n// BEGIN block\n// END block\n// SUFFIX\n",
  });
});

test("replace of a literal that covers a whole line replaces only its characters", async () => {
  expect(
    await run(replaceMutationTool, { source: file }, { start: "body line" }, { newText: "" }),
  ).toEqual({ source: "// PREFIX\n// BEGIN block\n\n// END block\n// SUFFIX\n" });
});

test("copy of a whole-line literal copies only its characters", async () => {
  expect(
    await run(
      copyMutationTool,
      { source: file, target: "left SLOT right\n" },
      { start: "body line", targetStart: "SLOT", targetEnd: "SLOT" },
    ),
  ).toEqual({ source: file, target: "left body line right\n" });
});

test("copy after a whole-line literal destination inserts right after its characters", async () => {
  expect(
    await run(
      copyMutationTool,
      { source: file, target: "first\nlast\n" },
      { start: "body line", targetStart: "first" },
    ),
  ).toEqual({ source: file, target: "firstbody line\nlast\n" });
});

test("move of a whole-line literal leaves its line break behind", async () => {
  expect(
    await run(
      moveMutationTool,
      { source: file, target: "left SLOT right\n" },
      { start: "body line", targetStart: "SLOT", targetEnd: "SLOT" },
    ),
  ).toEqual({
    source: "// PREFIX\n// BEGIN block\n\n// END block\n// SUFFIX\n",
    target: "left body line right\n",
  });
});

test("move of a line anchor still takes the whole line with its break", async () => {
  expect(
    await run(
      moveMutationTool,
      { source: file, target: "first\nlast\n" },
      { start: 3, targetStart: 1 },
    ),
  ).toEqual({
    source: "// PREFIX\n// BEGIN block\n// END block\n// SUFFIX\n",
    target: "first\nbody line\nlast\n",
  });
});
