import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createReadTool } from "#src/core/tools/tool-read.js";

test("caller cancellation returns a failed Read, not a completed source or an ordinary failure", async () => {
  const read = createReadTool();
  const controller = new AbortController();
  const reason = new Error("Caller stopped reading");
  let calls = 0;
  read.registerContributions("cancelled-source", {
    resolvers: [
      {
        resolver: {
          id: "memory",
          async tryResolve() {
            calls += 1;
            controller.abort(reason);
            return { kind: "failed", error: reason };
          },
        },
      },
    ],
  });
  try {
    const result = await read.execute(
      { path: 'memory:quoted"notes' },
      { cwd: "/workspace", signal: controller.signal },
    );
    expect(result.isError).toBe(true);
    expect(result.script).toBeUndefined();
    expect(result.details.failure?.cause).toBe(reason);
    expect(result.details.failure?.code).toBe("RESOLVE_FAILED");
    expect(result.content).toEqual([
      {
        type: "text",
        text: 'Read cancelled for "memory:quoted\\"notes". No completed result was returned.',
      },
    ]);
    expect(calls).toBe(1);
  } finally {
    await read.dispose();
  }
});

test.each(["TimeoutError", "AbortError"])(
  "a provider %s without caller cancellation remains an ordinary failed Read",
  async (name) => {
    const read = createReadTool();
    const controller = new AbortController();
    const reason = Object.assign(new Error("Provider stopped waiting"), { name });
    let calls = 0;
    read.registerContributions("provider-failure", {
      resolvers: [
        {
          resolver: {
            id: "memory",
            async tryResolve() {
              calls += 1;
              return { kind: "failed", error: reason };
            },
          },
        },
      ],
    });
    try {
      const result = await read.execute(
        { path: "memory:notes" },
        { cwd: "/workspace", signal: controller.signal },
      );
      expect(result.isError).toBe(true);
      expect(result.script).toBeUndefined();
      expect(result.details.failure?.cause).toBe(reason);
      expect(result.content).toEqual([
        { type: "text", text: 'Read failed for "memory:notes": Provider stopped waiting' },
      ]);
      expect(calls).toBe(1);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      await read.dispose();
    }
  },
);

test("raw cancellation still throws the original caller reason and a fresh Read succeeds", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "read-cancellation-"));
  const read = createReadTool();
  const controller = new AbortController();
  const reason = new Error("Stop these bytes");
  controller.abort(reason);
  try {
    await writeFile(path.join(cwd, "notes.txt"), "alpha\n");
    await expect(
      read.execute({ path: "raw:notes.txt" }, { cwd, signal: controller.signal }),
    ).rejects.toBe(reason);
    const fresh = await read.execute({ path: "raw:notes.txt", limit: 4 }, { cwd });
    expect(fresh.isError).not.toBe(true);
    expect(fresh.script).toMatchObject({ kind: "bytes", bytes: [97, 108, 112, 104] });
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe("alpha\n");
  } finally {
    await read.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
