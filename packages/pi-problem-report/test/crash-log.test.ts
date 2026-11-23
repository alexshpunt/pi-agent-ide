import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { crashError, takeUnreportedCrashes, type CrashRecord } from "pi-problem-report";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const ROOT = "/opt/pkg/node_modules/sample";

function crash(message: string, hoursAgo: number, frame = `${ROOT}/src/a.ts`): CrashRecord {
  return {
    timestamp: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    message,
    stack: `Error: ${message}\n    at run (${frame}:1:1)`,
    version: "1.6.0",
    kind: "uncaught_exception",
  };
}

function fixture(log: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "pi-problem-report-"));
  directories.push(directory);
  const crashLogPath = join(directory, "crashes.json");
  const statePath = join(directory, "state", "sample.json");
  const original = typeof log === "string" ? log : JSON.stringify(log);
  writeFileSync(crashLogPath, original);
  const take = (roots: readonly string[] = [ROOT]) =>
    takeUnreportedCrashes({ source: "sample", roots, crashLogPath, statePath, now: NOW });
  return { take, crashLogPath, statePath, original };
}

test("returns recent crashes in the extension once and leaves Pi's log untouched", () => {
  const ours = crash("OURS", 1);
  const { take, crashLogPath, original } = fixture([
    ours,
    crash("FOREIGN", 1, "/opt/pkg/node_modules/other/src/a.ts"),
    crash("OLD", 24 * 8),
    { ...crash("NO STACK", 1), stack: null },
    { ...crash("NOTIFIED", 2), notified: true },
  ]);
  expect(take().map((record) => record.message)).toEqual(["OURS", "NOTIFIED"]);
  expect(take()).toEqual([]);
  expect(readFileSync(crashLogPath, "utf8")).toBe(original);
});

test("a crash recorded later is returned on the next call", () => {
  const { take, crashLogPath } = fixture([crash("FIRST", 2)]);
  expect(take()).toHaveLength(1);
  writeFileSync(crashLogPath, JSON.stringify([crash("FIRST", 2), crash("SECOND", 1)]));
  expect(take().map((record) => record.message)).toEqual(["SECOND"]);
});

test("each source keeps its own record of returned crashes", () => {
  const { crashLogPath } = fixture([crash("SHARED", 1)]);
  const directory = mkdtempSync(join(tmpdir(), "pi-problem-report-"));
  directories.push(directory);
  for (const source of ["one", "two"])
    expect(
      takeUnreportedCrashes({
        source,
        roots: [ROOT],
        crashLogPath,
        statePath: join(directory, `${source}.json`),
        now: NOW,
      }),
    ).toHaveLength(1);
});

test.each([
  ["not JSON", "{oops"],
  ["an object", { records: [] }],
  ["records of the wrong shape", [{ timestamp: 1, message: "x" }, "text", null]],
])("a crash log with %s counts as no crash", (_name, log) => {
  expect(fixture(log).take()).toEqual([]);
});

test("a missing crash log counts as no crash", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-problem-report-"));
  directories.push(directory);
  expect(
    takeUnreportedCrashes({
      source: "sample",
      roots: [ROOT],
      crashLogPath: join(directory, "missing.json"),
      statePath: join(directory, "state.json"),
      now: NOW,
    }),
  ).toEqual([]);
});

test("the record of returned crashes stays bounded", () => {
  const { take, crashLogPath, statePath } = fixture([]);
  for (let index = 0; index < 30; index++) {
    writeFileSync(crashLogPath, JSON.stringify([crash(`A${index}`, 1), crash(`B${index}`, 1)]));
    expect(take()).toHaveLength(2);
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { reported: unknown[] };
  expect(state.reported.length).toBeLessThanOrEqual(50);
});

test("a crash becomes an error with its message and stack", () => {
  const record = crash("BOOM", 1);
  const error = crashError(record);
  expect(error.message).toBe("BOOM");
  expect(error.stack).toBe(record.stack);
});
