import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createReadTool } from "#src/core/tools/tool-read.js";

test("raw reads retain exact bytes and byte windows without invoking text handlers", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "raw-read-"));
  const read = createReadTool();
  read.registerContributions("reject-text", {
    handlers: [
      {
        stage: "pre-read",
        handler() {
          throw new Error("Text conversion must not run");
        },
      },
    ],
  });
  try {
    const bytes = [239, 187, 191, 65, 13, 10, 0, 255];
    await writeFile(path.join(cwd, "data.bin"), Buffer.from(bytes));
    const full = await read.execute({ path: "raw:data.bin" }, { cwd }, "script");
    expect(full.script).toMatchObject({
      kind: "bytes",
      bytes,
      byteOffset: 0,
      byteLength: 8,
      totalBytes: 8,
    });
    expect(full.details.lines).toBeUndefined();
    const tail = await read.execute(
      { path: "raw:data.bin", offset: -3, limit: 2 },
      { cwd },
      "script",
    );
    expect(tail.script).toMatchObject({ bytes: [10, 0], byteOffset: 5, byteLength: 2 });
    for (const offset of [8, 100]) {
      const empty = await read.execute({ path: "raw:data.bin", offset }, { cwd }, "script");
      expect(empty.script).toMatchObject({ bytes: [], byteOffset: 8 });
    }
    expect(
      (await read.execute({ path: "raw:data.bin", limit: 0 }, { cwd }, "script")).script,
    ).toMatchObject({ bytes: [] });
    for (const request of [{ offset: 0.5 }, { limit: -1 }, { views: ["ast"] }]) {
      expect((await read.execute({ path: "raw:data.bin", ...request }, { cwd })).isError).toBe(
        true,
      );
    }
    expect((await read.execute({ path: "raw:." }, { cwd })).isError).toBe(true);
  } finally {
    await read.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("raw agent output stays bounded and can continue while script data stays complete", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "raw-budget-"));
  const read = createReadTool();
  try {
    await writeFile(path.join(cwd, "large.bin"), Buffer.alloc(60000, 255));
    const first = await read.execute({ path: "raw:large.bin" }, { cwd });
    expect(first.details.byteLength).toBeGreaterThan(0);
    expect(first.details.byteLength).toBeLessThan(60000);
    expect(Buffer.byteLength(JSON.stringify(first.content))).toBeLessThan(51200);
    const next = await read.execute(
      { path: "raw:large.bin", offset: first.details.byteLength, limit: 16 },
      { cwd },
      "script",
    );
    expect(next.script).toMatchObject({
      byteOffset: first.details.byteLength,
      bytes: Array(16).fill(255),
    });
    const full = await read.execute({ path: "raw:large.bin" }, { cwd }, "script");
    expect(full.script).toMatchObject({ byteLength: 60000 });
  } finally {
    await read.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
