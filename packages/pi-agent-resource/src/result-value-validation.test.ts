import { expect, test } from "vitest";
import { ResultTargetStore, resultValueReference } from "./result-targets.ts";

function fixture() {
  const store = new ResultTargetStore();
  const id = store.register(
    [
      {
        source: "/workspace/note.txt",
        expectedContent: "OLD\n",
        ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 3 } }],
      },
    ],
    "/workspace",
  );
  return { store, id };
}

test.each(["anchor", "start", "end", "target", "targetStart", "targetEnd", "ranges", "extra"])(
  "refuses unsupported %s metadata before resolving an id-bearing value",
  (key) => {
    const { store, id } = fixture();
    const value = { id, [key]: "must not be ignored" };
    for (const resolve of [
      () => store.source(value, "/workspace"),
      () => store.source([value], "/workspace"),
      () => store.resolve(value, "/workspace"),
      () => resultValueReference(store, value, "/workspace"),
    ]) {
      expect(resolve).toThrow(
        expect.objectContaining({
          code: "INVALID_RESULT_VALUE",
          effect: "not-applied",
        }),
      );
    }
    expect(store.resolve(id, "/workspace").targets).toHaveLength(1);
  },
);

test("keeps issued Read, Search, match, capture, AST and LSP value metadata compatible", () => {
  const { store, id } = fixture();
  const match = {
    id,
    path: "/workspace/preview.txt",
    line: 1,
    text: "preview",
    lineText: "preview",
  };
  for (const value of [
    { id },
    { id, text: "OLD\n" },
    match,
    { ...match, captures: { NAME: [{ id, text: "OLD" }] } },
    { id, complete: false, matches: [match], notices: ["notice"], editWarning: "warning" },
    { id, complete: true, matches: [match], incoming: [match], outgoing: [] },
    { id, mode: "regex", complete: true, matches: [match] },
  ]) {
    expect(store.source(value, "/workspace")).toBe(id);
    expect(store.resolve(value, "/workspace")).toEqual(store.resolve(id, "/workspace"));
    expect(resultValueReference(store, value, "/workspace")).toBe(id);
  }
});
