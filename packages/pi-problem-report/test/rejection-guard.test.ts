import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);
const CHILD = fileURLToPath(new URL("fixtures/rejection-child.ts", import.meta.url));
// The child loads only the guard module, without Pi's packages.
const GUARD = pathToFileURL(
  createRequire(import.meta.url).resolve("pi-problem-report/rejection-guard"),
).href;

interface Event {
  event: string;
  detail?: unknown;
}

async function scenario(name: string): Promise<{ code: number; events: Event[] }> {
  let stdout: string;
  let code = 0;
  try {
    ({ stdout } = await run(process.execPath, [CHILD, name], {
      env: { ...process.env, GUARD_MODULE: GUARD, NODE_OPTIONS: "" },
      timeout: 20_000,
    }));
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    code = typeof failed.code === "number" ? failed.code : -1;
    stdout = typeof failed.stdout === "string" ? failed.stdout : "";
  }
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
  return { code, events };
}

test("an owned rejection is reported and the process keeps running", async () => {
  const { code, events } = await scenario("owned");
  expect(code).toBe(0);
  expect(events).toEqual([{ event: "reported", detail: "OURS failed" }, { event: "alive" }]);
});

test("a foreign rejection still reaches uncaughtException, as without the guard", async () => {
  const { code, events } = await scenario("foreign");
  expect(code).toBe(3);
  expect(events).toEqual([{ event: "uncaught", detail: { message: "FOREIGN failed" } }]);
});

test("a foreign non-error rejection crashes with Node's unhandled-rejection code", async () => {
  const { code, events } = await scenario("foreign-value");
  expect(code).toBe(3);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "uncaught",
    detail: { code: "ERR_UNHANDLED_REJECTION" },
  });
});

test("a foreign rejection is left to another unhandledRejection listener", async () => {
  const { code, events } = await scenario("foreign-with-listener");
  expect(code).toBe(0);
  expect(events).toEqual([
    { event: "other-listener", detail: "FOREIGN failed" },
    { event: "alive" },
  ]);
});

test("installing the same ID again replaces it, and removal drops the shared listener", async () => {
  const { code, events } = await scenario("reinstall");
  expect(code).toBe(0);
  expect(events).toEqual([
    { event: "listeners", detail: 1 },
    { event: "reported", detail: "OURS after reload" },
    { event: "listeners", detail: 0 },
    { event: "alive" },
  ]);
});

test("removing a replaced installation keeps the current one", async () => {
  const { code, events } = await scenario("stale-remove");
  expect(code).toBe(0);
  expect(events).toEqual([
    { event: "listeners", detail: 1 },
    { event: "reported", detail: "OURS still guarded" },
    { event: "alive" },
  ]);
});
