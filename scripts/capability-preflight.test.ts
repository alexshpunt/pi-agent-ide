import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, test } from "vitest";
import {
  assertPreflightInvocation,
  preflightSandboxArgs,
  runConnectorPreflight,
} from "#capabilities/preflight.ts";

const selection = ["--preflight", "--connector", "benvargas", "--connector-root", "/stage"];

test("historical unavailability never claims an observed isolated child", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capability-preflight-unit-"));
  try {
    const { report } = await runConnectorPreflight(process.cwd(), {
      connector: "legacy-agent-sdk",
      connectorRoot: "/missing-stage-must-not-be-opened",
      results: path.join(directory, "evidence"),
    });
    expect(report).toMatchObject({
      status: "unavailable",
      networkIsolation: "required",
      networkIsolated: null,
      inference: false,
    });
    expect(report.observed).toBeUndefined();
    expect(report.pi).toBeUndefined();
    expect(report.reasons.join(" ")).toContain("0.74");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("preflight requires one explicit connector and code root", () => {
  expect(() => assertPreflightInvocation(selection)).not.toThrow();
  expect(() => assertPreflightInvocation(["--preflight"])).toThrow(Error);
  expect(() => assertPreflightInvocation(selection.slice(1))).toThrow(Error);
  expect(() => assertPreflightInvocation([...selection, "--connector", "bridge"])).toThrow(Error);
  expect(() => assertPreflightInvocation([...selection, "--connector-root", "/other"])).toThrow(
    Error,
  );
});

test.each([
  "--run",
  "--auth-dir",
  "--claude-state",
  "--tui",
  "--model",
  "--case",
  "--mode",
  "--attempts",
  "--list",
  "--list-connectors",
  "--check",
  "--record-contracts",
])("preflight refuses inference/authentication or another action: %s", (flag) =>
  expect(() => assertPreflightInvocation([...selection, flag, "/never-read"])).toThrow(Error),
);

test("network isolation preserves the approved non-root CLI identity", () => {
  const identity = ["--unshare-user", "--uid", "1000", "--gid", "1000"];
  expect(preflightSandboxArgs([...identity, "--", "node"])).toEqual([
    ...identity,
    "--unshare-net",
    "--",
    "node",
  ]);
});
test("preflight puts mandatory network isolation before the child command", () => {
  const initial = ["--unshare-user", "--ro-bind", "/code", "/source", "--", "node"];
  const isolated = preflightSandboxArgs(initial);
  expect(isolated).toEqual([
    "--unshare-user",
    "--ro-bind",
    "/code",
    "/source",
    "--unshare-net",
    "--",
    "node",
  ]);
  expect(initial).not.toContain("--unshare-net");
  expect(() => preflightSandboxArgs(["--share-net", "--", "node"])).toThrow(Error);
  expect(() => preflightSandboxArgs(["node"])).toThrow(Error);
});
