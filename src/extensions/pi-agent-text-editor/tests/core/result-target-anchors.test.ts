import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { ResultTargetStore } from "pi-agent-resource";
import { createResultTargetAnchors } from "#src/core/result-target-anchors.ts";

const original = "zero\none\ntwo\nthree\n";

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "result-target-anchors-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "a.txt");
  await writeFile(source, original);
  const store = new ResultTargetStore();
  const reference = store.register(
    [
      {
        source,
        expectedContent: original,
        ranges: [{ start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 3 } }],
      },
    ],
    cwd,
  );
  const resolve = (content: string) =>
    createResultTargetAnchors(store).resolver.tryResolve(reference, {
      source,
      content,
      lines: content.split("\n"),
      cwd,
    });
  return { source, resolve };
}

test("a RESULT anchor resolves in the caller's text when another session wrote the file after the caller read it", async () => {
  const { source, resolve } = await fixture();
  // The caller read this text; another session then added a line above.
  const seen = `top\n${original}`;
  await writeFile(source, `peer\n${seen}`);
  const attempt = await resolve(seen);
  expect(attempt.kind, JSON.stringify(attempt)).toBe("resolved");
  if (attempt.kind !== "resolved") return;
  expect(attempt.anchor.lineNumber).toBe(4);
});

test("a RESULT anchor whose own line changed in the caller's text is stale", async () => {
  const { source, resolve } = await fixture();
  const seen = original.replace("two", "TWO");
  await writeFile(source, `top\n${original}`);
  expect(await resolve(seen)).toMatchObject({ kind: "rejected", rejection: { code: "stale" } });
});

/** A RESULT source whose file another session writes right after the store moved it to the file's text. */
async function racedSource() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "result-target-sources-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "a.txt");
  await writeFile(source, original);
  const store = new ResultTargetStore();
  const written = `peer\n${original}`;
  const reference = store.register(
    [
      {
        source,
        expectedContent: original,
        // The check reads the file through this reader; the write lands just before it.
        readCurrent: async () => {
          await writeFile(source, written);
          return written;
        },
        ranges: [{ start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 3 } }],
      },
    ],
    cwd,
  );
  const resolve = (edit?: { attempt: number }) =>
    requiredValue(createResultTargetAnchors(store).resources).tryResolve(reference, {
      cwd,
      ...(edit !== undefined && { edit }),
    });
  return { source, resolve };
}

test("an edit's RESULT source survives a write between its resolution and the file lock", async () => {
  const { source, resolve } = await racedSource();
  // The edit compares the target with the file under its lock and runs again on the newer text.
  const attempt = await resolve({ attempt: 0 });
  expect(attempt).toMatchObject({
    kind: "resolved",
    targets: [{ source, expectedContent: original }],
  });
});

test("a RESULT source without filesystem tracking still rejects changed text", async () => {
  const store = new ResultTargetStore();
  const reference = store.register(
    [
      {
        source: "memory://example/note",
        expectedContent: original,
        readCurrent: async () => `peer\n${original}`,
        ranges: [{ start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 3 } }],
      },
    ],
    "/workspace",
  );
  const resources = requiredValue(createResultTargetAnchors(store).resources);
  expect(await resources.tryResolve(reference, { cwd: "/workspace" })).toMatchObject({
    kind: "rejected",
    rejection: { code: "stale" },
  });
});
test("a RESULT source read survives a concurrent write outside its selection", async () => {
  const { source, resolve } = await racedSource();
  expect(await resolve()).toMatchObject({
    kind: "resolved",
    targets: [{ source, expectedContent: original }],
  });
});
