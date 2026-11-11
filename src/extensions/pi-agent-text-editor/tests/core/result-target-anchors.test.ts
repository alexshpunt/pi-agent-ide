import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, expect, test } from "vitest";
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
