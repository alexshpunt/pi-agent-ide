import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const root = findRepositoryRoot(import.meta.url);
const action = path.join(root, "scripts/ci-evidence-action.ts");

function fixture(run: (data: ReturnType<typeof setup>) => void) {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const cwd = mkdtempSync(path.join(root, ".tmp/ci-evidence-cli-"));
  try {
    run(setup(cwd));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function setup(cwd: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"));
  writeFileSync(path.join(cwd, ".github/workflows/ci.yml"), workflow);
  git("init", "-q");
  git("add", ".github");
  git("-c", "user.name=CI test", "-c", "user.email=ci@example.invalid", "commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const repository = "alexshpunt/pi-agent-ide";
  const evidence = {
    schema: 1,
    kind: "full",
    repository,
    workflowId: 338606493,
    workflow: createHash("sha256").update(workflow).digest("hex"),
    runId: 1234,
    runAttempt: 1,
    headCommit: "c".repeat(40),
    testedCommit: commit,
    tree,
    recordedAt: new Date(Date.now() - 60_000).toISOString(),
    toolchain: { node: "24.19.0", npm: "11.19.0", pnpm: "11.22.0" },
    images: { linux: "ubuntu24/20261005.1", windows: "windows2025/20261005.1" },
  };
  const sourceRun = {
    id: 1234,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    workflow_id: evidence.workflowId,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: evidence.headCommit,
    head_repository: { full_name: repository },
  };
  const jobs = ["Validate", "Validate Windows core"].map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    completed_at: evidence.recordedAt,
  }));
  const payload = { evidence, sourceRun, jobs, missing: false };
  const backendFile = path.join(cwd, "backend.json");
  const callsFile = path.join(cwd, "calls.jsonl");
  writeFileSync(
    path.join(cwd, "gh"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CI_TEST_CALLS, JSON.stringify(args) + "\\n");
const data = JSON.parse(fs.readFileSync(process.env.CI_TEST_BACKEND, "utf8"));
if (args[0] === "run" && args[1] === "download") {
  if (data.missing) process.exit(1);
  const dir = args[args.indexOf("--dir") + 1];
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(data.evidence));
} else if (args[0] === "api") {
  const route = args[1];
  const value = route.endsWith("actions/workflows/ci.yml") ? {id:data.evidence.workflowId}
    : route.includes("/runs?") ? {workflow_runs:[data.sourceRun]}
    : route.includes("/git/commits/") ? {tree:{sha:data.evidence.tree}}
    : route.includes("/jobs?") ? {jobs:data.jobs} : null;
  if (!value) process.exit(2);
  console.log(JSON.stringify(value));
} else process.exit(3);
`,
  );
  chmodSync(path.join(cwd, "gh"), 0o700);
  const eventPath = path.join(cwd, "event.json");
  writeFileSync(eventPath, "{}");
  function invoke(mode: string, env: Record<string, string> = {}) {
    writeFileSync(backendFile, JSON.stringify(payload));
    return JSON.parse(
      execFileSync(process.execPath, ["--experimental-strip-types", action, mode], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: `${cwd}${path.delimiter}${process.env.PATH}`,
          CI_TEST_CALLS: callsFile,
          CI_TEST_BACKEND: backendFile,
          GITHUB_OUTPUT: "",
          GITHUB_STEP_SUMMARY: "",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: repository,
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: commit,
          GITHUB_RUN_ID: "5678",
          GITHUB_RUN_ATTEMPT: "2",
          NODE_VERSION: evidence.toolchain.node,
          NPM_VERSION: evidence.toolchain.npm,
          PNPM_VERSION: evidence.toolchain.pnpm,
          ImageOS: "ubuntu24",
          ImageVersion: "20261005.1",
          CI_WINDOWS_IMAGE: evidence.images.windows,
          CI_LINUX_IMAGE: evidence.images.linux,
          CI_WINDOWS_TREE: tree,
          CI_LINUX_TREE: tree,
          CI_NIGHTLY: "false",
          CI_FULL: "true",
          ...env,
        },
      }),
    ) as Record<string, string>;
  }
  return { cwd, commit, tree, payload, invoke, callsFile, eventPath };
}

test.skipIf(process.platform === "win32")(
  "the real CLI binds downloaded evidence to GitHub jobs and the tested tree",
  () => {
    fixture(({ invoke, callsFile }) => {
      expect(invoke("decide")).toMatchObject({ full: "false", source_run: "1234" });
      const calls = readFileSync(callsFile, "utf8");
      expect(calls).toContain("ci-evidence-1");
      expect(calls).toContain("/attempts/1/jobs?");
      expect(calls).toContain("/git/commits/");
    });
  },
);

test.skipIf(process.platform === "win32")(
  "missing downloads and changed runner images force full checks",
  () => {
    fixture(({ invoke, payload }) => {
      payload.missing = true;
      expect(invoke("decide").full).toBe("true");
      payload.missing = false;
      expect(invoke("decide", { ImageVersion: "new", CI_LINUX_IMAGE: "ubuntu24/new" }).full).toBe(
        "true",
      );
    });
  },
);

test.skipIf(process.platform === "win32")(
  "PR and nightly executions never download evidence",
  () => {
    fixture(({ invoke, callsFile }) => {
      expect(invoke("decide", { GITHUB_EVENT_NAME: "pull_request" }).full).toBe("true");
      expect(invoke("decide", { CI_NIGHTLY: "true" }).full).toBe("true");
      expect(readFileSync(callsFile, "utf8")).not.toContain("download");
    });
  },
);

test.skipIf(process.platform === "win32")(
  "recording preserves the PR head and actual tested merge commit separately",
  () => {
    fixture(({ invoke, cwd, commit, tree, payload, eventPath }) => {
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { head: { sha: payload.evidence.headCommit } } }),
      );
      expect(invoke("record", { GITHUB_EVENT_NAME: "pull_request" })).toEqual({ recorded: "true" });
      const proof: unknown = JSON.parse(
        readFileSync(path.join(cwd, ".agents/tmp/ci-evidence/evidence.json"), "utf8"),
      );
      expect(proof).toMatchObject({
        headCommit: payload.evidence.headCommit,
        testedCommit: commit,
        tree,
        runId: 5678,
        runAttempt: 2,
      });
    });
  },
);

test.skipIf(process.platform === "win32")("unknown runner metadata cannot create evidence", () => {
  fixture(({ invoke, cwd }) => {
    expect(invoke("record", { CI_WINDOWS_IMAGE: "" })).toMatchObject({ recorded: "false" });
    expect(() => readFileSync(path.join(cwd, ".agents/tmp/ci-evidence/evidence.json"))).toThrow(
      "ENOENT",
    );
  });
});

test.skipIf(process.platform === "win32")(
  "recording cannot mint proof from evidence-only runs or unsuccessful core jobs",
  () => {
    fixture(({ invoke, payload }) => {
      expect(() => invoke("record", { CI_FULL: "false" })).toThrow(
        "An evidence-only run cannot record full proof",
      );
      const windows = payload.jobs[1];
      if (!windows) throw Error("Missing Windows job");
      windows.conclusion = "failure";
      expect(() => invoke("record")).toThrow("Full jobs cannot grant evidence");
    });
  },
);
