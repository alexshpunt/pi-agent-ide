import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { TextAnchor, textLineAnchors } from "pi-agent-text";
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
  const resolve = (field: string, endAfter?: number) => {
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
      ...(endAfter === undefined ? {} : { endAfter }),
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
    resolveAnchors: async (field, start) => resolve(field, start?.offset),
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
function displayLine(content: string, line: number, copiedText: string) {
  return `${textLineAnchors("fixture.txt", content)[line - 1]}|${copiedText}`;
}

test("replace accepts a copied CRLF and BOM display using LF and fuzzy text", async () => {
  const source = "\uFEFFalpha\u00A0one\r\nbravo chunk\r\ncharlie";
  const start = [displayLine(source, 1, "alpha one"), displayLine(source, 2, "bravo")].join("\n");
  expect(await run(replaceMutationTool, { source }, { start }, { text: "revised\nbeta" })).toEqual({
    source: "\uFEFFrevised\r\nbeta chunk\r\ncharlie",
  });
});

test("insert uses the exact content boundary of a copied prefix and partial line", async () => {
  expect(
    await run(
      insertMutationTool,
      { source: file },
      { anchor: displayLine(file, 3, "body") },
      { text: " of" },
    ),
  ).toEqual({ source: file.replace("body line", "body of line") });
});

test("delete maps both copied endpoints back to their original characters", async () => {
  expect(
    await run(
      deleteMutationTool,
      { source: file },
      {
        start: displayLine(file, 2, "// BEGIN"),
        end: displayLine(file, 4, "// END"),
      },
    ),
  ).toEqual({ source: "// PREFIX\n block\n// SUFFIX\n" });
});

test("copy replaces the span between copied destination selectors with the source bytes", async () => {
  const target = "alpha\nbeta\ngamma\n";
  expect(
    await run(
      copyMutationTool,
      { source: file, target },
      {
        start: displayLine(file, 3, "body"),
        targetStart: displayLine(target, 1, "alpha"),
        targetEnd: displayLine(target, 2, "bet"),
      },
    ),
  ).toEqual({ source: file, target: "bodya\ngamma\n" });
});

test("move removes only the copied selector's characters and transfers no prefixes", async () => {
  const target = "left\nright\n";
  expect(
    await run(
      moveMutationTool,
      { source: file, target },
      {
        start: displayLine(file, 3, "body"),
        targetStart: displayLine(target, 1, "left"),
      },
    ),
  ).toEqual({ source: file.replace("body line", " line"), target: "leftbody\nright\n" });
});

test("insert after a literal that covers a whole line adds the text right after it", async () => {
  expect(
    await run(insertMutationTool, { source: file }, { anchor: "// END block" }, { text: "// X" }),
  ).toEqual({ source: file.replace("// END block", "// END block// X") });
});

test("insert before a literal that covers a whole line adds the text right before it", async () => {
  expect(
    await run(
      insertMutationTool,
      { source: file },
      { anchor: "// END block" },
      { text: "// X", before: true },
    ),
  ).toEqual({ source: file.replace("// END block", "// X// END block") });
});

test("single-line insertion after a line anchor uses the exact boundary (LPT-1747)", async () => {
  expect(await run(insertMutationTool, { source: file }, { anchor: 4 }, { text: "// X" })).toEqual({
    source: file.replace("// END block", "// END block// X"),
  });
});

test("deleting a whole-line literal takes its line break (LPT-1747)", async () => {
  expect(await run(deleteMutationTool, { source: file }, { start: "body line" })).toEqual({
    source: "// PREFIX\n// BEGIN block\n// END block\n// SUFFIX\n",
  });
});

test("deleting a span between whole-line literals removes the lines (LPT-1747)", async () => {
  expect(
    await run(
      deleteMutationTool,
      { source: file },
      { start: "// BEGIN block", end: "// END block" },
    ),
  ).toEqual({ source: "// PREFIX\n// SUFFIX\n" });
});

test("delete of a line anchor still removes the line with its break", async () => {
  expect(await run(deleteMutationTool, { source: file }, { start: 3 })).toEqual({
    source: "// PREFIX\n// BEGIN block\n// END block\n// SUFFIX\n",
  });
});

test("empty replacement deletes the whole line selected by a literal (LPT-1747)", async () => {
  expect(
    await run(replaceMutationTool, { source: file }, { start: "body line" }, { text: "" }),
  ).toEqual({ source: "// PREFIX\n// BEGIN block\n// END block\n// SUFFIX\n" });
});

test("copy of a whole-line literal over a partial span keeps character boundaries (LPT-1747)", async () => {
  expect(
    await run(
      copyMutationTool,
      { source: file, target: "left SLOT right\n" },
      { start: "body line", targetStart: "SLOT", targetEnd: "SLOT" },
    ),
  ).toEqual({ source: file, target: "left body line right\n" });
});

test("copy after a whole-line literal destination adds a line (LPT-1747)", async () => {
  expect(
    await run(
      copyMutationTool,
      { source: file, target: "first\nlast\n" },
      { start: "body line", targetStart: "first" },
    ),
  ).toEqual({ source: file, target: "first\nbody line\nlast\n" });
});

test("move of a whole-line literal removes its line break (LPT-1747)", async () => {
  expect(
    await run(
      moveMutationTool,
      { source: file, target: "left SLOT right\n" },
      { start: "body line", targetStart: "SLOT", targetEnd: "SLOT" },
    ),
  ).toEqual({
    source: "// PREFIX\n// BEGIN block\n// END block\n// SUFFIX\n",
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

const repeatedEnd = "before END\nBEGIN body END then END after";
const from = "BEGIN";
const to = "END";

test("replace pairs a unique start with the nearest following exact end", async () => {
  expect(
    await run(
      replaceMutationTool,
      { source: repeatedEnd },
      { start: from, end: to },
      { text: "NEW" },
    ),
  ).toEqual({ source: "before END\nNEW then END after" });
});

test("delete pairs a unique start with the nearest following exact end", async () => {
  expect(await run(deleteMutationTool, { source: repeatedEnd }, { start: from, end: to })).toEqual({
    source: "before END\n then END after",
  });
});

for (const tool of [copyMutationTool, moveMutationTool]) {
  test(`${tool.name} uses the nearest following end in both source and destination pairs`, async () => {
    const target = "END stays\nleft SLOT old END then END";
    expect(
      await run(
        tool,
        { source: repeatedEnd, target },
        { start: from, end: to, targetStart: "SLOT", targetEnd: to },
      ),
    ).toEqual({
      source: tool.name === "copy" ? repeatedEnd : "before END\n then END after",
      target: "END stays\nleft BEGIN body END then END",
    });
  });
}

test("a pair skips an end inside a multiline start and accepts an adjacent end", async () => {
  expect(
    await run(
      replaceMutationTool,
      { source: "pre BEGIN\nEND-END and END stays" },
      { start: "BEGIN\nEND-", end: "END" },
      { text: "NEW" },
    ),
  ).toEqual({ source: "pre NEW and END stays" });
});

test("a unique end that overlaps the start is refused", async () => {
  await expect(
    run(deleteMutationTool, { source: "pre BEGIN\nEND more" }, { start: "BEGIN\nEN", end: "END" }),
  ).rejects.toMatchObject({ code: "ANCHOR_RANGE_OVERLAP" });
});

test("a unique end before the start remains reversed even with a later fuzzy match", async () => {
  await expect(
    run(
      deleteMutationTool,
      { source: "end marker\nBEGIN body end\u00a0marker" },
      { start: "BEGIN", end: "end marker" },
    ),
  ).rejects.toMatchObject({ code: "ANCHOR_RANGE_REVERSED" });
});
