import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runAxi } from "#linear/axi.ts";

let workspace: string;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  workspace = await mkdtemp(path.join(process.cwd(), ".tmp/packaged-axi-"));
  const agentDir = path.join(workspace, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PATH", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});

// `--help` is not a worker command, so runAxi first starts the backend's worker, learns it
// cannot run the arguments, and then starts the CLI itself: two cold module loads. Each takes
// seconds on a loaded machine, so the test gets more than vitest's 5 s default. runAxi's own
// 30 s limit still ends a CLI that never starts, and a CLI that fails to start fails the test
// through its output assertions or error.
test(
  "runs the packaged CLI from an unrelated project without an installed PATH command",
  { timeout: 60_000 },
  async () => {
    const output = await runAxi(workspace, ["--help"]);
    expect(output).toContain("usage: linear-axi");
    expect(output).toContain("issues");
    expect(output).toContain("resources");
  },
);
