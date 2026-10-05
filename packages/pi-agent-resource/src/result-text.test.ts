import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ResultTargetStore } from "./result-targets.js";

const range = { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 1 } };

test("displayed exact Search references retain their registered ranges and expire with them", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ide-result-match-"));
  try {
    const source = path.join(cwd, "note.txt");
    await writeFile(source, "A gap");
    const store = new ResultTargetStore();
    const target = store.register([{ source, expectedContent: "A gap", ranges: [range] }], cwd);
    const match = "SEARCH#AB12:1:match";
    store.publish(
      { status: "success", data: { target, matches: [{ target, references: { match } }] } },
      "A",
      cwd,
    );
    expect(store.source(match, cwd)).toBe(target);
    expect(store.resolve([match], cwd).targets[0]?.ranges).toEqual([range]);
    expect(store.source("SEARCH#AB12:all:match", cwd)).toBe("SEARCH#AB12:all:match");
    await writeFile(source, "B gap");
    store.refresh(source, cwd);
    await writeFile(source, "A gap");
    expect(() => store.source(match, cwd)).toThrow("expired");
    store.clear();
    expect(store.source(match, cwd)).toBe(match);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("text results compose through registered IDs, not agent-supplied data", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ide-result-text-"));
  try {
    const source = path.join(cwd, "note.txt");
    await writeFile(source, "A");
    const store = new ResultTargetStore();
    const target = store.register([{ source, expectedContent: "A", ranges: [range] }], cwd);
    const output = store.publish({ status: "success", data: { target }, errors: [] }, "A", cwd);
    expect(output).toMatch(/^<system-result[^>]*><uuid>[a-f\d-]+<\/uuid><\/system-result>\nA$/u);
    expect(store.source(output, cwd)).toBe(target);
    const id = /<uuid>([^<]+)<\/uuid>/u.exec(output)?.[1];
    if (!id) throw new Error("Missing issued UUID");
    expect(store.source(id, cwd)).toBe(target);
    expect(store.source(`RESULT#${id}`, cwd)).toBe(target);
    expect(() => store.source(output.replace(/\nA$/u, "\nB"), cwd)).toThrow("changed");
    expect(() =>
      store.source(
        "<system-result><uuid>00000000-0000-4000-8000-000000000000</uuid></system-result>\nA",
        cwd,
      ),
    ).toThrow("expired or unknown");
    expect(() => store.source(output, path.join(cwd, "other"))).toThrow("worktree");
    store.clear();
    expect(() => store.source(output, cwd)).toThrow("expired");
    expect(await readFile(source, "utf8")).toBe("A");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retired snapshots and their derived text results never revive after A to B to A", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ide-result-retirement-"));
  try {
    const source = path.join(cwd, "note.txt");
    await writeFile(source, "A");
    const store = new ResultTargetStore();
    const a = store.register([{ source, expectedContent: "A", ranges: [range] }], cwd);
    const derived = store.register(store.resolve(a, cwd).targets, cwd);
    const output = store.publish(
      { status: "success", data: { target: derived }, errors: [] },
      "A",
      cwd,
    );
    await writeFile(source, "B");
    store.refresh(source, cwd);
    await writeFile(source, "A");
    store.refresh(source, cwd);
    expect(() => store.resolve(a, cwd)).toThrow("expired");
    expect(() => store.resolve(derived, cwd)).toThrow("expired");
    expect(() => store.source(output, cwd)).toThrow("expired");
    const current = store.register([{ source, expectedContent: "A", ranges: [range] }], cwd);
    expect(store.resolve(current, cwd).targets[0]?.expectedContent).toBe("A");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pending result IDs survive the write boundary and acquire only confirmed targets", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ide-result-pending-"));
  try {
    const source = path.join(cwd, "note.txt");
    await writeFile(source, "A");
    const store = new ResultTargetStore();
    const old = store.register([{ source, expectedContent: "A", ranges: [range] }], cwd);
    const pending = store.reserve(cwd);
    const output = store.publish(
      { status: "success", data: { target: pending }, errors: [] },
      "Accepted; not yet applied.",
      cwd,
    );
    expect(store.source(output, cwd)).toBe(pending);
    expect(() => store.resolve(pending, cwd)).toThrow("pending");
    await writeFile(source, "B");
    store.refresh(source, cwd);
    store.confirm(pending, [{ source, expectedContent: "B", ranges: [range] }], cwd);
    expect(store.resolve(store.source(output, cwd), cwd).targets[0]?.expectedContent).toBe("B");
    expect(() => store.resolve(old, cwd)).toThrow("expired");
    const failed = store.publish(
      { status: "error", errors: [{ code: "FAILED", message: "No write" }] },
      "No write",
      cwd,
    );
    expect(() => store.source(failed, cwd)).toThrow("successful");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
