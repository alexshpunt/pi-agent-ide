import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ResultTargetStore,
  currentResultTargets,
  describeAdjustedRanges,
  type ResultRange,
  type ResultSourceTarget,
} from "./result-targets.ts";

const target: ResultSourceTarget = {
  source: "/workspace/a.txt",
  expectedContent: "a b\n",
  ranges: [{ start: { lineNumber: 1, column: 2 }, end: { lineNumber: 1, column: 3 } }],
};

describe("source result targets", () => {
  test("numbered Search aliases retain registered authority and worktree guards", () => {
    const store = new ResultTargetStore();
    const selected = store.register([target], "/workspace");
    store.registerSearchReference("SEARCH#ABCD:1:line", selected, "/workspace");
    expect(store.resolve("SEARCH#ABCD:1:line", "/workspace")).toEqual({
      targets: [target],
      complete: true,
    });
    expect(() => store.resolve("SEARCH#ABCD:1:line", "/other")).toThrow(/another worktree/u);
    expect(() =>
      store.registerSearchReference("SEARCH#ABCD:1:line", "SEARCH#ABCD:1:line", "/workspace"),
    ).toThrow(/registered result target/u);
    expect(() =>
      store.registerSearchReference("SEARCH#ABCD:all:line", selected, "/workspace"),
    ).toThrow(/numbered Search references/u);
    expect(() =>
      store.registerSearchReference("SEARCH#ABCD:2:line", "RESULT#missing", "/workspace"),
    ).toThrow(/registered result target/u);
    store.invalidate(target.source);
    expect(() => store.resolve("SEARCH#ABCD:1:line", "/workspace")).toThrow(/expired/u);
  });
  test("keeps snapshot authority out of projected JSON and returned coordinates", () => {
    const store = new ResultTargetStore();
    const reference = store.register([target], "/workspace");
    const resolved = store.resolve(
      { target: reference, source: "/workspace/wrong.txt", ranges: [] },
      "/workspace",
    );
    expect(resolved.targets).toEqual([target]);
    Object.assign(resolved.targets[0]?.ranges[0]?.start ?? {}, { column: 0 });
    expect(store.resolve(reference, "/workspace").targets).toEqual([target]);
    expect(() =>
      store.resolve({ source: target.source, ranges: target.ranges }, "/workspace"),
    ).toThrow("no supported source target");
  });

  test("keeps incomplete source knowledge through subsets and duplicate targets", () => {
    const store = new ResultTargetStore();
    const reference = store.register([target], "/workspace", false);
    const resolved = store.resolve([{ target: reference }, { target: reference }], "/workspace");
    expect(resolved).toEqual({ targets: [target], complete: false });
    expect(store.resolve([], "/workspace")).toEqual({ targets: [], complete: true });
  });

  test("keeps declared selection order for paired operations without duplicate ranges", () => {
    const store = new ResultTargetStore();
    const firstTarget = {
      ...target,
      ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 1 } }],
    };
    const first = store.register([firstTarget], "/workspace");
    const second = store.register([target], "/workspace", false);
    const selected = store.resolveOrdered([second, first, second], "/workspace");
    expect(selected).toEqual({ targets: [target, firstTarget], complete: false });
    Object.assign(selected.targets[0]?.ranges[0]?.start ?? {}, { column: 0 });
    expect(store.resolve(second, "/workspace").targets).toEqual([target]);
  });

  test("rejects conflicting snapshots, another worktree, and expired handles", () => {
    const store = new ResultTargetStore();
    const first = store.register([target], "/workspace");
    const second = store.register([{ ...target, expectedContent: "changed\n" }], "/workspace");
    expect(() => store.resolve([first, second], "/workspace")).toThrow("different snapshots");
    expect(() => store.resolve(first, "/other-worktree")).toThrow("another worktree");
    store.clear();
    expect(() => store.resolve(first, "/workspace")).toThrow("expired or unknown");
  });

  test("known URI edits retire old selections even when the original text returns", async () => {
    const store = new ResultTargetStore();
    let content = "a b\n";
    const owned = {
      ...target,
      source: "memory://demo/note",
      readCurrent: async () => content,
    };
    const original = store.register([owned], "/workspace");
    const derived = store.register(
      [
        {
          ...owned,
          ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 1 } }],
        },
      ],
      "/workspace",
    );
    const published = store.publish(
      { status: "success", data: { target: original } },
      "Original resource",
      "/workspace",
      [owned.source],
    );
    store.registerSearchReference("SEARCH#ABCD:1:match", derived, "/workspace");
    const sibling = store.register([{ ...owned, source: "memory://other/note" }], "/workspace");

    content = "a c\n";
    store.refresh(owned.source, "/workspace", true);
    const changed = store.register([{ ...owned, expectedContent: content }], "/workspace");
    await store.verify(store.resolve(changed, "/workspace"));
    store.refresh(owned.source, "/workspace");
    expect(store.resolve(changed, "/workspace").targets[0]?.ranges).toEqual(owned.ranges);

    content = owned.expectedContent;
    store.refresh(owned.source, "/workspace", true);
    for (const reference of [original, derived, published, "SEARCH#ABCD:1:match", changed])
      expect(() => store.resolve(reference, "/workspace")).toThrow(/expired/u);
    expect(store.resolve(sibling, "/workspace").targets[0]?.source).toBe("memory://other/note");
  });

  test("input sent to a live session keeps its results resolvable", () => {
    const store = new ResultTargetStore();
    const shell = store.publish({ status: "success" }, "Shell output", "/workspace", [
      "shell:abc123",
    ]);
    const debug = store.publish({ status: "success" }, "Debugger state", "/workspace", [
      "debug:node-1",
    ]);
    store.refresh("shell:abc123", "/workspace", true);
    store.refresh("debug:node-1", "/workspace", true);
    expect(store.source(shell, "/workspace", "live")).toBe("shell:abc123");
    expect(store.source(debug, "/workspace", "live")).toBe("debug:node-1");
  });

  test("a script value resolves its id like the reference itself and ignores other fields", () => {
    const store = new ResultTargetStore();
    const selected = store.register([target], "/workspace");
    const published = store.publish(
      { status: "success", data: { target: selected } },
      "Selected text",
      "/workspace",
    );
    const id = `RESULT#${/<uuid>([a-f\d-]{36})<\/uuid>/u.exec(published)?.[1] ?? ""}`;
    expect(store.source({ id }, "/workspace")).toBe(selected);
    expect(store.source({ id, path: "/workspace/b.txt", text: "other" }, "/workspace")).toBe(
      selected,
    );
    expect(store.source([{ id }, published], "/workspace")).toEqual([selected, selected]);
    expect(store.resolve({ id }, "/workspace")).toEqual(store.resolve(id, "/workspace"));
    store.registerSearchReference("SEARCH#ABCD:1:match", selected, "/workspace");
    expect(store.source({ id: "SEARCH#ABCD:1:match" }, "/workspace")).toBe(selected);
  });

  test("a script value with an id the store did not issue fails like an unknown reference", () => {
    const store = new ResultTargetStore();
    for (const id of [
      "RESULT#00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000000",
      "RESULT#missing",
      "a.txt",
      "",
    ])
      expect(() => store.source({ id }, "/workspace")).toThrow(
        "Result reference expired or unknown",
      );
  });

  test("a known edit preserves pending output handles and their resulting spans", async () => {
    const store = new ResultTargetStore();
    const owned = {
      ...target,
      source: "memory://demo/note",
      readCurrent: async () => "a c\n",
    };
    const old = store.register([owned], "/workspace");
    const pending = store.reserve("/workspace");
    const published = store.publish(
      { status: "success", data: { target: pending } },
      "Pending mutation",
      "/workspace",
    );
    store.refresh(owned.source, "/workspace", true);
    expect(() => store.resolve(old, "/workspace")).toThrow(/expired/u);
    const committed = { ...owned, expectedContent: "a c\n" };
    store.confirm(pending, [committed], "/workspace");
    const resolved = store.resolve(published, "/workspace");
    expect(resolved.targets).toEqual([committed]);
    await store.verify(resolved);
  });

  test("confirms pending handles once without rebinding committed snapshots", () => {
    const store = new ResultTargetStore();
    const reference = store.reserve("/workspace");
    expect(() => store.resolve(reference, "/workspace")).toThrow("pending");
    expect(() => store.confirm(reference, [target], "/other-worktree")).toThrow("this worktree");
    store.confirm(reference, [target], "/workspace");
    expect(store.resolve(reference, "/workspace").targets).toEqual([target]);
    expect(() =>
      store.confirm(reference, [{ ...target, expectedContent: "new" }], "/workspace"),
    ).toThrow("Only a pending result");
    store.reject(reference, "later failure");
    expect(store.resolve(reference, "/workspace").targets).toEqual([target]);
    const rejected = store.reserve("/workspace");
    store.reject(rejected, "Write was cancelled");
    expect(() => store.resolve(rejected, "/workspace")).toThrow("Write was cancelled");
    expect(() => store.confirm(rejected, [target], "/workspace")).toThrow("Only a pending result");
  });

  test("preserves zero-width positions as targets rather than an empty set", () => {
    const store = new ResultTargetStore();
    const position = {
      ...target,
      ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 0 } }],
    };
    const reference = store.register([position], "/workspace");
    expect(store.resolve(reference, "/workspace").targets).toEqual([position]);
  });
});

describe("selections of a local file edited elsewhere", () => {
  let directory: string;
  let file: string;
  const original = "one\ntwo\nthree\nfour\nfive\n";
  const line = (lineNumber: number): ResultRange => ({
    start: { lineNumber, column: 0 },
    end: { lineNumber, column: 3 },
  });
  const select = (store: ResultTargetStore, ...ranges: ResultRange[]): string =>
    store.register([{ source: file, expectedContent: original, ranges }], directory);

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "result-targets-"));
    file = path.join(directory, "a.txt");
    writeFileSync(file, original);
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function edit(content: string): void {
    writeFileSync(file, content);
  }

  test("follow the text when lines were added above", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(3));
    const content = `zero\nzero\n${original}`;
    edit(content);
    const [moved] = store.resolve(reference, directory).targets;
    expect(moved).toMatchObject({ source: file, expectedContent: content, ranges: [line(5)] });
  });

  test("stay in place when lines below changed", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(3));
    const content = original.replace("four\nfive", "4\n5\n6");
    edit(content);
    const [kept] = store.resolve(reference, directory).targets;
    expect(kept).toMatchObject({ expectedContent: content, ranges: [line(3)] });
  });

  test("expire when an edit overlaps the selected text", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(3));
    edit(original.replace("three", "thr33"));
    expect(() => store.resolve(reference, directory)).toThrow(/expired/u);
  });

  test("expire as a whole when one of several ranges changed", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(1), line(4));
    edit(original.replace("four", "FOUR"));
    expect(() => store.resolve(reference, directory)).toThrow(/expired/u);
  });

  test("expire when a line is inserted inside a multi-line selection", () => {
    const store = new ResultTargetStore();
    const reference = select(store, {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 4, column: 4 },
    });
    edit(original.replace("three\n", "three\nnew\n"));
    expect(() => store.resolve(reference, directory)).toThrow(/expired/u);
  });

  test("keep Search references and published results usable", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(4));
    store.registerSearchReference("SEARCH#ABCD:1:line", reference, directory);
    const published = store.publish(
      { status: "success", data: { target: reference } },
      "Search result",
      directory,
      [file],
    );
    edit(`zero\n${original}`);
    expect(store.resolve("SEARCH#ABCD:1:line", directory).targets[0]?.ranges).toEqual([line(5)]);
    expect(store.source(published, directory)).toBe(reference);
  });

  test("keep selections across several edits and drop only the ones that changed", () => {
    const store = new ResultTargetStore();
    const stable = select(store, line(5));
    const doomed = select(store, line(2));
    edit(`zero\n${original}`);
    expect(store.resolve(stable, directory).targets[0]?.ranges).toEqual([line(6)]);
    edit(`zero\n${original}`.replace("five", "last\nfive"));
    expect(store.resolve(stable, directory).targets[0]?.ranges).toEqual([line(7)]);
    edit(`zero\n${original}`.replace("five", "last\nfive").replace("two", "2"));
    expect(() => store.resolve(doomed, directory)).toThrow(/expired/u);
    expect(store.resolve(stable, directory).targets[0]?.ranges).toEqual([line(7)]);
  });

  test("survive a known edit of other lines and report the edited ones as expired", () => {
    const store = new ResultTargetStore();
    const edited = select(store, line(2));
    const other = select(store, line(4));
    edit(original.replace("two", "2\n2"));
    store.refresh(file, directory, true);
    expect(() => store.resolve(edited, directory)).toThrow(/expired/u);
    expect(store.resolve(other, directory).targets[0]?.ranges).toEqual([line(5)]);
  });

  test("verify against the moved text", async () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(3));
    edit(`zero\n${original}`);
    await expect(store.verify(store.resolve(reference, directory))).resolves.toBeUndefined();
  });

  test("expire when the file is deleted", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(3));
    rmSync(file);
    expect(() => store.resolve(reference, directory)).toThrow(/expired/u);
  });

  test("expire when the file was rewritten beyond recognition", () => {
    const store = new ResultTargetStore();
    const reference = select(store, line(3));
    edit(Array.from({ length: 9000 }, (_, index) => `row ${index}`).join("\n"));
    expect(() => store.resolve(reference, directory)).toThrow(/expired/u);
  });
});

describe("selections registered from a text the file no longer has", () => {
  let directory: string;
  let file: string;
  const original = "one\ntwo\nthree\nfour\nfive\n";
  const line = (lineNumber: number): ResultRange => ({
    start: { lineNumber, column: 0 },
    end: { lineNumber, column: 3 },
  });
  // A search registers each match separately, always with the text it read.
  const match = (store: ResultTargetStore, lineNumber: number, content = original): string =>
    store.register(
      [{ source: file, expectedContent: content, ranges: [line(lineNumber)] }],
      directory,
    );

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "result-targets-registered-"));
    file = path.join(directory, "a.txt");
    writeFileSync(file, original);
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("matches of one search form one set when another session writes while they are registered", async () => {
    const store = new ResultTargetStore();
    const before = [1, 2].map((lineNumber) => match(store, lineNumber));
    const content = `zero\n${original}`;
    writeFileSync(file, content);
    const after = [4, 5].map((lineNumber) => match(store, lineNumber));
    const resolved = store.resolve([...before, ...after], directory);
    expect(resolved.targets).toEqual([
      {
        source: file,
        expectedContent: content,
        ranges: [line(2), line(3), line(5), line(6)],
      },
    ]);
    await expect(store.verify(resolved)).resolves.toBeUndefined();
  });

  test("a search that read the file before it changed combines with a later search", async () => {
    const store = new ResultTargetStore();
    const content = `zero\n${original}`;
    writeFileSync(file, content);
    const earlier = match(store, 3);
    const later = match(store, 5, content);
    const resolved = store.resolve([earlier, later], directory);
    expect(resolved.targets).toEqual([
      { source: file, expectedContent: content, ranges: [line(4), line(5)] },
    ]);
    await expect(store.verify(resolved)).resolves.toBeUndefined();
  });

  test("a write between resolving a selection and verifying it leaves the file's other selections usable", async () => {
    const store = new ResultTargetStore();
    const checked = match(store, 2);
    const other = match(store, 4);
    const resolved = store.resolve(checked, directory);
    writeFileSync(file, `zero\n${original}`);
    await expect(store.verify(resolved)).rejects.toThrow(/stale/u);
    expect(store.resolve(other, directory).targets[0]?.ranges).toEqual([line(5)]);
    expect(store.resolve(checked, directory).targets[0]?.ranges).toEqual([line(3)]);
  });

  test("a match whose own text changed before it was registered is refused with its current line", () => {
    const store = new ResultTargetStore();
    writeFileSync(file, original.replace("three", "thr33"));
    const changed = match(store, 3);
    const kept = match(store, 4);
    expect(() => store.resolve(changed, directory)).toThrow(/thr33/u);
    expect(store.resolve(kept, directory).targets[0]?.ranges).toEqual([line(4)]);
  });
});

describe("selections whose own lines were edited, for readers", () => {
  let directory: string;
  let file: string;
  const original = "one\ntwo\nthree\nfour\nfive\n";
  const block: ResultRange = {
    start: { lineNumber: 2, column: 0 },
    end: { lineNumber: 4, column: 4 },
  };
  const select = (store: ResultTargetStore, ...ranges: ResultRange[]): string =>
    store.register([{ source: file, expectedContent: original, ranges }], directory);

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "result-targets-readers-"));
    file = path.join(directory, "a.txt");
    writeFileSync(file, original);
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("resolve to the same region of the current text and are marked", async () => {
    const store = new ResultTargetStore();
    const reference = select(store, block);
    const content = `zero\n${original.replace("three", "THREE")}`;
    writeFileSync(file, content);
    const current = await store.resolveCurrent(reference, directory);
    expect(current.targets).toEqual([
      {
        source: file,
        expectedContent: content,
        ranges: [
          {
            ...block,
            start: { lineNumber: 3, column: 0 },
            end: { lineNumber: 5, column: 4 },
            adjusted: true,
          },
        ],
      },
    ]);
    expect(describeAdjustedRanges(current, directory)).toContain("a.txt:3-5");
  });

  test("are refused to anything that edits, which needs the selected text", async () => {
    const store = new ResultTargetStore();
    const reference = select(store, block);
    writeFileSync(file, original.replace("three", "THREE"));
    expect(() => store.resolve(reference, directory)).toThrow(/expired/u);
    expect(() => store.resolveOrdered(reference, directory)).toThrow(/expired/u);
    await expect(store.resolveCurrent(reference, directory)).resolves.toBeDefined();
  });

  test("stay usable through later edits, and unchanged ones are not marked", async () => {
    const store = new ResultTargetStore();
    const edited = select(store, block);
    const untouched = select(store, {
      start: { lineNumber: 5, column: 0 },
      end: { lineNumber: 5, column: 4 },
    });
    writeFileSync(file, original.replace("three", "THREE"));
    await store.resolveCurrent(edited, directory);
    writeFileSync(file, `zero\n${original.replace("three", "THREE").replace("four", "4\n4")}`);
    const current = await store.resolveCurrent(edited, directory);
    expect(current.targets[0]?.ranges[0]).toMatchObject({
      start: { lineNumber: 3, column: 0 },
      end: { lineNumber: 7, column: 0 },
      adjusted: true,
    });
    const moved = await store.resolveCurrent(untouched, directory);
    expect(moved.targets[0]?.ranges[0]).toEqual({
      start: { lineNumber: 7, column: 0 },
      end: { lineNumber: 7, column: 4 },
    });
    expect(describeAdjustedRanges(moved, directory)).toBeUndefined();
  });

  test("follow a write that lands after the result was resolved", async () => {
    const store = new ResultTargetStore();
    const reference = select(store, block);
    const resolved = store.resolve(reference, directory);
    const content = `zero\n${original.replace("three", "THREE")}`;
    writeFileSync(file, content);
    const current = await currentResultTargets(resolved);
    expect(current.targets[0]?.expectedContent).toBe(content);
    expect(current.targets[0]?.ranges[0]).toMatchObject({
      start: { lineNumber: 3, column: 0 },
      adjusted: true,
    });
  });

  test("fail only when no line of the region is left", async () => {
    const store = new ResultTargetStore();
    const reference = select(store, {
      start: { lineNumber: 3, column: 0 },
      end: { lineNumber: 3, column: 5 },
    });
    const resolved = store.resolve(select(store, block), directory);
    writeFileSync(file, original.replace("three", "thr33"));
    await expect(store.resolveCurrent(reference, directory)).rejects.toThrow(/expired/u);
    writeFileSync(file, "unrelated\n");
    await expect(currentResultTargets(resolved)).rejects.toThrow(/no longer be found/u);
  });

  test("keep published results usable for readers", async () => {
    const store = new ResultTargetStore();
    const reference = select(store, block);
    const published = store.publish(
      { status: "success", data: { target: reference } },
      "Read",
      directory,
      [file],
    );
    writeFileSync(file, original.replace("three", "THREE"));
    const current = await store.resolveCurrent(published, directory);
    expect(current.targets[0]?.ranges[0]).toMatchObject({ adjusted: true });
  });
});
