import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { createTextEditorCore } from "./text-editor-core.js";
import { prepareResultTransfer } from "./result-transfer.js";
import { executeWholeFileTool } from "./file-operation-tools.js";

test.each([false, true])(
  "Move returns unchanged destination points (same file: %s)",
  async (sameFile) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "move-no-op-"));
    try {
      const source = path.join(cwd, "source.txt");
      const target = sameFile ? source : path.join(cwd, "target.txt");
      await writeFile(source, "left right\n");
      if (!sameFile) await writeFile(target, "left right\n");
      const store = new ResultTargetStore();
      const point = (file: string, column: number) =>
        store.register(
          [
            {
              source: file,
              expectedContent: "left right\n",
              ranges: [{ start: { lineNumber: 1, column }, end: { lineNumber: 1, column } }],
            },
          ],
          cwd,
        );
      const destination = point(target, 5);
      const prepared = await prepareResultTransfer(
        "move",
        { path: point(source, 0), target: destination },
        store,
        cwd,
      );
      expect(prepared.empty).toBe(false);
      const reference = prepared.noOpTarget;
      if (reference === undefined) throw new Error("Missing unchanged destination points.");
      expect(store.resolve(reference, cwd)).toEqual(store.resolve(destination, cwd));
      expect(prepared.mutate).toBeUndefined();
      const multiple = await prepareResultTransfer(
        "move",
        {
          path: [point(source, 0), point(source, 1), point(source, 0)],
          target: [point(target, 5), point(target, 6), point(target, 5)],
        },
        store,
        cwd,
      );
      if (multiple.noOpTarget === undefined) throw new Error("Missing paired destination points.");
      expect(store.resolve(multiple.noOpTarget, cwd).targets[0]?.ranges).toHaveLength(2);
      await expect(
        prepareResultTransfer(
          "move",
          {
            path: [point(source, 0), point(source, 1)],
            target: destination,
          },
          store,
          cwd,
        ),
      ).rejects.toThrow(/counts must match/u);
      const incomplete = store.register(store.resolve(destination, cwd).targets, cwd, false);
      await expect(
        prepareResultTransfer("move", { path: point(source, 0), target: incomplete }, store, cwd),
      ).rejects.toThrow(/Incomplete/u);
      await expect(
        prepareResultTransfer(
          "move",
          { path: point(source, 0), target: point(target, 99) },
          store,
          cwd,
        ),
      ).rejects.toThrow(/outside/u);
      await expect(
        prepareResultTransfer(
          "move",
          { path: point(source, 0), target: point(source, 0) },
          store,
          cwd,
        ),
      ).rejects.toThrow(/overlap or touch/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
test.each(["copy", "move"] as const)(
  "%s rechecks a whole-file result after waiting for queued edits",
  async (operation) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "result-transfer-"));
    try {
      const source = path.join(cwd, "source.txt");
      const target = path.join(cwd, "destination.txt");
      await writeFile(source, "old\r\n");
      const store = new ResultTargetStore();
      const reference = store.register(
        [
          {
            source,
            expectedContent: "old\r\n",
            ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } }],
          },
        ],
        cwd,
      );
      const prepared = await prepareResultTransfer(
        operation,
        { path: reference, target },
        store,
        cwd,
      );
      const core = createTextEditorCore();
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prior = core.enqueueFileOperation(async () => {
        await waiting;
        await writeFile(source, "changed\r\n");
      });
      const transfer = executeWholeFileTool(
        core,
        operation,
        prepared.input,
        undefined,
        { cwd },
        prepared.verifyFileSource,
      );
      release();
      await prior;
      const result = await transfer;
      expect(result.details.metadata?.semanticAction).toMatchObject({
        ok: false,
        effect: "not-applied",
        error: { code: "RESULT_INPUT_REJECTED" },
      });
      expect(await readFile(source, "utf8")).toBe("changed\r\n");
      await expect(readFile(target)).rejects.toThrow(/ENOENT/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
