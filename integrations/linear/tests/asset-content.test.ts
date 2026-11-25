import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { convertAsset } from "#linear/asset-content.ts";

// Observe Node's real Worker creation event; the converter and its dependencies stay intact.
let workersCreated = 0;
function countWorker() {
  workersCreated++;
}

const archive = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 0, 13, 10]);
const malformedPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

// Loading the converters' module graph takes seconds on a loaded machine; pay it once here so
// each test's own budget covers only the behavior it checks.
beforeAll(async () => {
  process.on("worker", countWorker);
  await convertAsset("linear://example/asset", archive);
}, 60_000);
afterAll(() => {
  process.off("worker", countWorker);
});

test("consecutive conversions, including a rejected file, reuse one loaded worker", async () => {
  const before = workersCreated;
  await expect(convertAsset("linear://example/asset", malformedPng)).rejects.toThrow(
    "LINEAR_ASSET_FORMAT_UNSUPPORTED",
  );
  const converted = await convertAsset("linear://example/asset", png);
  expect(converted).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]),
  );
  expect(await convertAsset("linear://example/asset", archive)).toBeUndefined();
  expect(workersCreated).toBe(before);
});

test("concurrent conversions each get their own result", async () => {
  const results = await Promise.allSettled([
    convertAsset("linear://example/a", png),
    convertAsset("linear://example/b", malformedPng),
    convertAsset("linear://example/c", archive),
  ]);
  const [image, invalid] = results;
  expect(image.status === "fulfilled" && Array.isArray(image.value)).toBe(true);
  const failure: unknown = invalid.status === "rejected" ? invalid.reason : undefined;
  expect(failure).toMatchObject({ message: "LINEAR_ASSET_FORMAT_UNSUPPORTED" });
  expect(results[2]).toEqual({ status: "fulfilled", value: undefined });
});

test("a cancelled conversion stops its worker and later conversions still run", async () => {
  const controller = new AbortController();
  const running = convertAsset("linear://example/a", png, controller.signal);
  const queued = new AbortController();
  const waiting = convertAsset("linear://example/b", png, queued.signal);
  const after = convertAsset("linear://example/c", archive);
  const before = workersCreated;
  queued.abort();
  controller.abort();
  await expect(running).rejects.toThrow("LINEAR_ASSET_READ_CANCELLED");
  await expect(waiting).rejects.toThrow("LINEAR_ASSET_READ_CANCELLED");
  // The next conversion needs a new worker, which loads the converters again.
  expect(await after).toBeUndefined();
  expect(workersCreated).toBe(before + 1);
}, 60_000);

test("a loaded but idle converter worker does not keep the process alive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-asset-exit-"));
  try {
    // A script file, not --eval: the worker inherits the parent's execArgv.
    const script = path.join(directory, "convert.mjs");
    const module = import.meta.resolve("#linear/asset-content.ts");
    const loader = import.meta.resolve("jiti");
    await writeFile(
      script,
      [
        `import { createJiti } from ${JSON.stringify(loader)};`,
        `const { convertAsset } = await createJiti(import.meta.url).import(${JSON.stringify(module)});`,
        'await convertAsset("linear://example/asset", Buffer.from([0x50, 0x4b, 3, 4]));',
        'console.log("converted");',
      ].join("\n"),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 45_000 });
    expect(stdout).toBe("converted\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
