import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

import { ResultTargetStore, type ResourceResolver } from "pi-agent-resource";
import { expect, onTestFinished, test } from "vitest";

import { createReadResultTargetHandler } from "#src/core/tools/read/result-target.js";
import { createReadTool } from "#src/core/tools/tool-read.js";

v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc") as () => void;

function liveHeap(): number {
  collectGarbage();
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

const filesystem = {
  id: "filesystem",
  async tryResolve(source, context) {
    const file = path.resolve(context.cwd, source);
    const bytes = await readFile(file);
    return {
      kind: "resolved",
      resource: {
        source: file,
        sourceBytes: bytes,
        async read() {
          return [{ type: "text", text: bytes.toString("utf8") }];
        },
      },
    };
  },
} satisfies ResourceResolver;

test("repeated reads of an unchanged file retain one copy of it in their result targets", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-read-target-memory-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  // About 1 MiB in 27k lines, like the C++ file where each Search snapshot read leaked.
  const lines = Array.from(
    { length: 27_000 },
    (_, index) => `  value_${index} = compute(${index});`,
  );
  await writeFile(path.join(cwd, "main.cpp"), `${lines.join("\n")}\n`);
  const store = new ResultTargetStore();
  const read = createReadTool();
  read.registerContributions("fixture", {
    resolvers: [{ resolver: filesystem }],
    handlers: [{ stage: "post-read", handler: createReadResultTargetHandler(store, read.execute) }],
  });
  const readFile_ = async () => {
    const result = await read.execute({ path: "main.cpp" }, { cwd }, "script");
    expect(result.script?.kind === "text" && result.script.target).toBeTruthy();
  };

  await readFile_();
  const afterOneRead = liveHeap();
  for (let index = 0; index < 20; index += 1) await readFile_();

  expect(liveHeap() - afterOneRead).toBeLessThan(10 * 1024 * 1024);
});

test("results Pi keeps for short reads of a changing file do not keep each file version", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-read-result-memory-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const lines = Array.from(
    { length: 27_000 },
    (_, index) => `  value_${index} = compute(${index});`,
  );
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, `${lines.join("\n")}\n`);
  const read = createReadTool();
  read.registerContributions("fixture", { resolvers: [{ resolver: filesystem }] });
  // Pi keeps every returned result in the session transcript. The IDE copies its details and
  // structured content before Pi keeps them (see detached-results.test.ts); this keeps the rest.
  const kept: unknown[] = [];
  const readLines = async (index: number) => {
    await writeFile(source, `${lines.join("\n")}\n// version ${index}\n`);
    const {
      details: _details,
      structuredContent: _structuredContent,
      ...result
    } = await read.tool.execute(
      `call-${index}`,
      { path: "main.cpp", offset: 100, limit: 5 },
      undefined,
      undefined,
      { cwd } as Parameters<typeof read.tool.execute>[4],
    );
    kept.push(result);
  };

  await readLines(0);
  const afterOneRead = liveHeap();
  for (let index = 1; index <= 20; index += 1) await readLines(index);

  expect(liveHeap() - afterOneRead).toBeLessThan(10 * 1024 * 1024);
  expect(kept).toHaveLength(21);
});
