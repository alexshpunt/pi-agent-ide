import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const cli = process.env.PI_EVAL_CLI;

interface Report {
  trials: {
    agentProfile: string;
    score: { passed: boolean; reward: number };
    metrics: Record<string, number | null>;
    agentMetrics: { failedToolCalls: number };
  }[];
  comparisons: { completePairs: number }[];
}

// The evaluator is an optional test facility, not a target or production dependency.
test.skipIf(cli === undefined)(
  "the real evaluator recovers the same external write locally and over SSH",
  async () => {
    if (cli === undefined) throw new Error("Set PI_EVAL_CLI to the installed evaluator CLI");
    const runId = `integration-${randomUUID()}`;
    const generated = path.resolve(".tmp/ssh-parity-eval", runId);
    const result = path.resolve(".tmp/ssh-parity-eval/results", runId);
    const workspace = path.resolve(".tmp/ssh-parity-eval/workspaces", runId);
    await mkdir(generated, { recursive: true });
    try {
      const config = path.join(generated, "config.mjs");
      await execute("pnpm", [
        "exec",
        "esbuild",
        "dev/evals/ssh-parity.config.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=external",
        `--outfile=${config}`,
      ]);
      await execute(
        process.execPath,
        [
          cli,
          "run",
          "ssh-parity",
          "contracts",
          "--config",
          config,
          "--agent-profiles",
          "local,ssh",
          "--model",
          "scripted/scripted-model",
          "--thinking",
          "off",
          "--task",
          "files-recovery",
          "--run-id",
          runId,
        ],
        {
          env: { ...process.env, PI_SSH_EVAL_SCRIPTED: "1" },
          timeout: 150_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const report = JSON.parse(
        await readFile(path.join(result, "summary.json"), "utf8"),
      ) as Report;
      expect(report.trials).toHaveLength(2);
      expect(report.trials.map((trial) => trial.agentProfile).sort()).toEqual(["local", "ssh"]);
      for (const trial of report.trials) {
        expect(trial.score).toMatchObject({ passed: true, reward: 1 });
        expect(trial.metrics["custom.conflicts"]).toBeGreaterThan(0);
        expect(trial.metrics["custom.rounds"]).toBe(3);
        expect(trial.metrics["custom.tool-context-bytes"]).toBeGreaterThan(0);
        expect(trial.agentMetrics.failedToolCalls).toBeGreaterThan(0);
      }
      expect(report.comparisons[0]?.completePairs).toBe(1);
    } finally {
      // Cleanup only these unique suite-owned artifacts; fixture teardown is awaited by the suite.
      await Promise.all(
        [generated, result, workspace].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
    }
  },
  180_000,
);
