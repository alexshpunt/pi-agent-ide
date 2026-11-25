import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { axiPath } from "#linear/config.ts";

let directory: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  directory = await mkdtemp(path.join(process.cwd(), ".tmp/config-"));
  cwd = path.join(directory, "project");
  agentDir = path.join(directory, "agent");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test("global CLI configuration works outside a configured project", async () => {
  await writeFile(
    path.join(agentDir, "linear.json"),
    JSON.stringify({ axiPath: "/backend/bin.js" }),
  );
  expect(await axiPath(cwd)).toBe("/backend/bin.js");
});

test("project CLI configuration overrides the global value", async () => {
  await writeFile(
    path.join(agentDir, "linear.json"),
    JSON.stringify({ axiPath: "/global/bin.js" }),
  );
  await writeFile(path.join(cwd, ".pi/linear.json"), JSON.stringify({ axiPath: "backend/bin.js" }));
  expect(await axiPath(cwd)).toBe(path.join(cwd, "backend/bin.js"));
});

test("relative global CLI paths resolve from the agent directory", async () => {
  await writeFile(
    path.join(agentDir, "linear.json"),
    JSON.stringify({ axiPath: "backend/bin.js" }),
  );
  expect(await axiPath(cwd)).toBe(path.join(agentDir, "backend/bin.js"));
});

test("missing configurations use the package CLI from an unrelated project without PATH", async () => {
  vi.stubEnv("PATH", "");
  const executable = await axiPath(cwd);
  expect(path.isAbsolute(executable)).toBe(true);
  expect(executable).toMatch(/[\\/]dist[\\/]bin\.js$/u);
  expect(await realpath(executable)).toBe(
    await realpath(fileURLToPath(import.meta.resolve("#linear-axi/dist/bin.js"))),
  );
});

test("an explicit PATH command is not converted to a local filename", async () => {
  await writeFile(path.join(agentDir, "linear.json"), JSON.stringify({ axiPath: "linear-axi" }));
  expect(await axiPath(cwd)).toBe("linear-axi");
});

test("invalid project configuration cannot fall back to another backend", async () => {
  await writeFile(
    path.join(agentDir, "linear.json"),
    JSON.stringify({ axiPath: "/global/bin.js" }),
  );
  await writeFile(path.join(cwd, ".pi/linear.json"), JSON.stringify({ axiPath: "" }));
  await expect(axiPath(cwd)).rejects.toThrow("LINEAR_CONFIG_FAILED");
});

test("invalid global configuration fails instead of silently using PATH", async () => {
  await writeFile(path.join(agentDir, "linear.json"), JSON.stringify({ axiPath: "" }));
  await expect(axiPath(cwd)).rejects.toThrow("LINEAR_CONFIG_FAILED");
});
