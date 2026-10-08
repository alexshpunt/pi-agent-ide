import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import type { TextMutationContext } from "#src/api/mutation-tool.js";
import { TextChangeDocument, applyTextChanges } from "#src/core/text-change-engine.js";
import { prepareResultTransfer } from "#src/core/result-transfer.js";

function fixture() {
  const cwd = process.cwd();
  const source = `${cwd}/.tmp/transfer-source.txt`;
  const destination = "ssh://right/work/destination.txt";
  const texts = new Map([
    [source, "first café last"],
    [destination, "ONE TWO"],
  ]);
  const store = new ResultTargetStore();
  const selected = (file: string, from: number, to: number, complete = true) => {
    const content = texts.get(file);
    if (content === undefined) throw Error("Unknown owned source");
    return store.register(
      [
        {
          source: file,
          expectedContent: content,
          readCurrent: async () => texts.get(file) ?? "",
          ranges: [{ start: { lineNumber: 1, column: from }, end: { lineNumber: 1, column: to } }],
        },
      ],
      cwd,
      complete,
    );
  };
  const documentFor = (file: string) => {
    const content = texts.get(file);
    if (content === undefined) throw Error("Unknown owned document");
    return new TextChangeDocument(content);
  };
  const context: TextMutationContext = {
    cwd,
    sourceDocument: documentFor(source),
    documentFor,
    sourceFor: (field) => (field === "path" ? source : destination),
    targetDocument: () => documentFor(destination),
    resolveAnchors: async () => {
      throw Error("Structured inputs must not resolve string anchors");
    },
    resolveAnchor: async () => {
      throw Error("Structured inputs must not resolve string anchors");
    },
  };
  return { cwd, source, destination, texts, store, selected, context };
}

test("structured transfers pair ranges in declared order and remove only repeated ranges", async () => {
  const f = fixture();
  const first = f.selected(f.source, 0, 5);
  const last = f.selected(f.source, 11, 15);
  const one = f.selected(f.destination, 0, 3);
  const two = f.selected(f.destination, 4, 7);
  const prepared = await prepareResultTransfer(
    "copy",
    { path: [last, first, last], target: [one, two, one] },
    f.store,
    f.cwd,
  );
  const mutation = await prepared.mutate?.(f.context);
  const edit = mutation?.edits.get(f.destination);
  expect(edit?.changes).toEqual([
    { from: 0, to: 3, insert: "last", allowUnchanged: true },
    { from: 4, to: 7, insert: "first", allowUnchanged: true },
  ]);
  expect(mutation?.edits.has(f.source)).toBe(false);
  expect(applyTextChanges("ONE TWO", edit?.changes ?? []).content).toBe("last first");
});

test("structured transfers reject count mismatches, incomplete inputs and mixed selectors", async () => {
  const f = fixture();
  const first = f.selected(f.source, 0, 5);
  const last = f.selected(f.source, 11, 15);
  const one = f.selected(f.destination, 0, 3);
  await expect(
    prepareResultTransfer("copy", { path: [first, last], target: one }, f.store, f.cwd),
  ).rejects.toThrow(/counts must match/u);
  await expect(
    prepareResultTransfer(
      "copy",
      { path: f.selected(f.source, 0, 5, false), target: one },
      f.store,
      f.cwd,
    ),
  ).rejects.toThrow(/Incomplete/u);
  await expect(
    prepareResultTransfer("copy", { path: first, start: "first", target: one }, f.store, f.cwd),
  ).rejects.toThrow(/combine/u);
  await expect(
    prepareResultTransfer("copy", { path: first, target: f.destination }, f.store, f.cwd),
  ).rejects.toThrow(/partial/u);
});

test("moves reject destinations touching any source before returning effects", async () => {
  const f = fixture();
  const first = f.selected(f.source, 0, 5);
  const last = f.selected(f.source, 11, 15);
  const touching = f.selected(f.source, 5, 5);
  const outside = f.selected(f.destination, 0, 3);
  const prepared = await prepareResultTransfer(
    "move",
    { path: [last, first], target: [touching, outside] },
    f.store,
    f.cwd,
  );
  await expect(prepared.mutate?.(f.context)).rejects.toThrow(/overlap or touch/u);
  expect(f.texts.get(f.source)).toBe("first café last");
});

test("a prepared transfer refuses a snapshot changed after resolution", async () => {
  const f = fixture();
  const prepared = await prepareResultTransfer(
    "copy",
    { path: f.selected(f.source, 0, 5), target: f.selected(f.destination, 0, 3) },
    f.store,
    f.cwd,
  );
  f.texts.set(f.source, "external café last");
  await expect(prepared.mutate?.(f.context)).rejects.toThrow(/stale/u);
});

test("empty paired selections are no-ops, not whole-file fallback", async () => {
  const f = fixture();
  const empty = f.store.register([], f.cwd);
  const prepared = await prepareResultTransfer(
    "copy",
    { path: empty, target: empty },
    f.store,
    f.cwd,
  );
  expect(prepared.empty).toBe(true);
});
