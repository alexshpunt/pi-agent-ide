import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import {
  adoptSessionApplyUndo,
  disposeSessionApplyUndo,
  retainSessionApplyUndo,
} from "#src/core/apply/reload-journals.js";

async function fixture() {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/reload-journals-"));
  const file = path.join(root, "note.txt");
  const first = createTextEditorCore();
  const access = first.getApplyFileAccess({ cwd: root });
  await writeFile(file, "before");
  const before = await access.capture(file);
  await writeFile(file, "after");
  const receipt = await first.recordApplyUndo([before], access);
  return { root, file, first, receipt };
}

test("reload keeps real disk journals for the same session and extension", async () => {
  const { root, file, first, receipt } = await fixture();
  const next = createTextEditorCore();
  try {
    await retainSessionApplyUndo(first, root, "session-one");
    await adoptSessionApplyUndo(next, root, "session-one");
    expect(next.hasApplyUndo(receipt)).toBe(true);
    await next.restoreApplyUndo(receipt);
    expect(await readFile(file, "utf8")).toBe("before");
  } finally {
    await disposeSessionApplyUndo(next, root);
    await first.disposeApplyUndo();
    await rm(root, { recursive: true, force: true });
  }
});

test("a different session releases the old receipt without changing its file", async () => {
  const { root, file, first, receipt } = await fixture();
  const next = createTextEditorCore();
  try {
    await retainSessionApplyUndo(first, root, "session-one");
    await adoptSessionApplyUndo(next, root, "session-two");
    expect(next.hasApplyUndo(receipt)).toBe(false);
    await expect(next.restoreApplyUndo(receipt)).rejects.toMatchObject({
      code: "APPLY_UNDO_UNAVAILABLE",
    });
    expect(await readFile(file, "utf8")).toBe("after");
  } finally {
    await disposeSessionApplyUndo(next, root);
    await first.disposeApplyUndo();
    await rm(root, { recursive: true, force: true });
  }
});

test("another checkout cannot take a retained session's journal owner", async () => {
  const { root, file, first, receipt } = await fixture();
  const other = createTextEditorCore();
  const next = createTextEditorCore();
  try {
    await retainSessionApplyUndo(first, root, "session-one");
    await adoptSessionApplyUndo(other, `${root}/other-checkout`, "session-one");
    expect(other.hasApplyUndo(receipt)).toBe(false);
    await adoptSessionApplyUndo(next, root, "session-one");
    await next.restoreApplyUndo(receipt);
    expect(await readFile(file, "utf8")).toBe("before");
  } finally {
    await disposeSessionApplyUndo(next, root);
    await other.disposeApplyUndo();
    await first.disposeApplyUndo();
    await rm(root, { recursive: true, force: true });
  }
});
