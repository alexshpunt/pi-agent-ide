import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { createTextEditorCore } from "#src/core/text-editor-core.js";

test("queued Apply undo does not block unrelated file operations", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "undo-concurrency-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const core = createTextEditorCore();
  const source = path.join(cwd, "first.txt");
  await writeFile(source, "new");
  const receipt = await core.recordApplyUndo([
    { path: source, existed: true, bytes: Buffer.from("old") },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    release();
  }, 1000);
  const blocker = core.enqueueFileOperation(() => gate, undefined, { cwd, sources: [source] });
  const undo = core.restoreApplyUndo(receipt, new AbortController().signal);
  try {
    await core.enqueueFileOperation(
      () => writeFile(path.join(cwd, "other.txt"), "other"),
      undefined,
      {
        cwd,
        sources: ["other.txt"],
      },
    );
    expect(timedOut).toBe(false);
    expect(await readFile(source, "utf8")).toBe("new");
  } finally {
    clearTimeout(watchdog);
    release();
    await Promise.allSettled([blocker, undo]);
  }
  await expect(undo).resolves.toMatchObject({ restored: [source] });
  expect(await readFile(source, "utf8")).toBe("old");
});
