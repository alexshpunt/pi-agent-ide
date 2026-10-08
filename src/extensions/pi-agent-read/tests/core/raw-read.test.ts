import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ResourceResolutionAttempt } from "pi-agent-resource";
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
    if (process.platform !== "win32") {
      await writeFile(path.join(cwd, "name:bytes.bin"), Buffer.from(bytes));
      expect(
        (await read.execute({ path: "raw:name:bytes.bin" }, { cwd }, "script")).script,
      ).toMatchObject({ bytes });
    }
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

test("raw resources use the owning byte reader and run guards before fetching bytes", async () => {
  const read = createReadTool();
  const source = "memory://target/data.bin";
  const bytes = Uint8Array.from([0, 255, 13, 10, 65]);
  let calls = 0;
  let denied = false;
  read.registerContributions("byte-provider", {
    resolvers: [
      {
        resolver: {
          id: "memory-bytes",
          async tryResolve(input): Promise<ResourceResolutionAttempt> {
            if (input !== source) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  throw new Error("Text conversion must not run");
                },
                async readBytes(offset: number, limit: number | undefined) {
                  calls++;
                  const start = Math.min(
                    bytes.length,
                    Math.max(0, offset < 0 ? bytes.length + offset : offset),
                  );
                  return {
                    bytes: bytes.slice(start, start + (limit ?? bytes.length)),
                    byteOffset: start,
                    totalBytes: bytes.length,
                  };
                },
              },
            };
          },
        },
      },
    ],
    resourceGuards: [
      {
        id: "deny-bytes",
        guard(event) {
          expect(event.requestedSource).toBe(`raw:${source}`);
          expect(event.resourceSource).toBe(`raw:${source}`);
          return denied ? { kind: "rejected", reason: "private bytes" } : { kind: "accepted" };
        },
      },
    ],
  });
  try {
    expect(
      (await read.execute({ path: `raw:${source}` }, { cwd: "/local" }, "script")).script,
    ).toMatchObject({
      kind: "bytes",
      source: `raw:${source}`,
      bytes: Array.from(bytes),
      totalBytes: 5,
    });
    expect(
      (
        await read.execute(
          { path: `raw:${source}`, offset: -2, limit: 1 },
          { cwd: "/local" },
          "script",
        )
      ).script,
    ).toMatchObject({ bytes: [10], byteOffset: 3, byteLength: 1 });
    expect(
      (await read.execute({ path: `raw:${source}`, limit: 0 }, { cwd: "/local" }, "script")).script,
    ).toMatchObject({ bytes: [], byteLength: 0 });
    const prior = calls;
    denied = true;
    expect((await read.execute({ path: `raw:${source}` }, { cwd: "/local" })).isError).toBe(true);
    expect(calls).toBe(prior);
    expect(
      (await read.execute({ path: `raw:${source}`, views: ["ast"] }, { cwd: "/local" })).isError,
    ).toBe(true);
    expect(calls).toBe(prior);
  } finally {
    await read.dispose();
  }
});
