import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { createTextEditorCore } from "./text-editor-core.js";
import { prepareResultTransfer } from "./result-transfer.js";
import { executeWholeFileTool } from "./file-operation-tools.js";

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
