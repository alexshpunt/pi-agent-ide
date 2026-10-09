import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { testArtifactsDir } from "pi-coding-agent-test";
import { capabilityCases } from "#capabilities/cases.ts";
import {
  prepareTrial,
  sandboxArgs,
  runProcess,
  cleanupTrial,
  validateFiles,
} from "#capabilities/sandbox.ts";

// Start separate real Pi processes: capability sandbox isolation is part of this contract.
test.each(["direct", "codemode"])(
  "semantic rename updates references in the capability sandbox through %s",
  async (mode) => {
    const task = capabilityCases.find((task) => task.id === "lsp-rename");
    if (!task) throw Error("Missing semantic rename case");
    const root = path.join(process.cwd(), ".tmp");
    await mkdir(root, { recursive: true });
    const parent = await mkdtemp(path.join(root, "semantic-rename-"));
    const trial = await prepareTrial(parent, process.cwd(), task);
    try {
      const execution = await runProcess(
        "bwrap",
        [
          ...(await sandboxArgs(process.cwd(), trial.root)),
          "node",
          "/source/tests/integration/support/capability-semantic-rename.ts",
          mode,
        ],
        {
          env: {
            // setup-node installs the global LSP beside this Node binary on CI.
            // Its /opt toolchain is already mounted read-only by the sandbox.
            PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(
              path.delimiter,
            ),
            HOME: "/state/home",
            PI_CODING_AGENT_DIR: "/state/agent",
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            TERM: "xterm-256color",
            LANG: "C.UTF-8",
          },
          timeoutMs: 120_000,
        },
      );
      await cp(
        path.join(trial.state, "results"),
        path.join(testArtifactsDir(import.meta.filename), mode),
        { recursive: true },
      );
      expect(execution.timedOut, execution.stderr).toBe(false);
      expect(execution.code, execution.stderr).toBe(0);
      const result = JSON.parse(execution.stdout) as {
        route: { passed: boolean; reasons: string[] };
        errors: string[];
        rejectedCount: number;
        unchangedAfterRejection: boolean;
        renameModes: string[];
      };
      expect(result.route, execution.stdout).toEqual({ passed: true, reasons: [] });
      expect(result.errors).toEqual([]);
      expect(result.rejectedCount).toBe(1);
      expect(result.unchangedAfterRejection).toBe(true);
      expect(result.renameModes).toEqual(["lsp-rename"]);
      expect(await validateFiles(trial.cwd, trial.initial, task.expected)).toEqual([]);
    } finally {
      await cleanupTrial(parent, trial.root);
      await rm(parent, { recursive: true, force: true });
    }
  },
  180_000,
);
