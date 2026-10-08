import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

interface WorkflowStep {
  name: string;
  if?: string;
  uses?: string;
  with?: { name?: string; path?: string; "include-hidden-files"?: boolean };
  env?: Record<string, string>;
  run?: string;
  "continue-on-error"?: boolean;
}

interface WorkflowJob {
  name?: string;
  outputs?: Record<string, string>;
  "continue-on-error"?: boolean;
  steps: WorkflowStep[];
  needs?: string | string[];
  if?: string;
  strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
}

test("runs real debuggers outside blocking checks and shared CI statistics", () => {
  const workflow = parse(
    readFileSync(
      path.join(findRepositoryRoot(import.meta.url), ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as { jobs: Record<string, WorkflowJob> };
  for (const name of ["validate", "integration", "integration-namespaces", "validate-windows-core"])
    expect(workflow.jobs[name]?.["continue-on-error"], name).not.toBe(true);
  const integration = workflow.jobs.integration;
  expect(integration?.steps.some((step) => step.name === "Run integration shard")).toBe(true);
  for (const name of ["debugger-core", "java-debugger-lifecycle", "debugger-matrix"]) {
    const job = workflow.jobs[name];
    expect(job, name).toBeDefined();
    expect(job?.["continue-on-error"], name).toBe(true);
    expect(
      job?.steps.some((step) => step.run?.includes("debugger")),
      name,
    ).toBe(true);
    expect(
      job?.steps.some((step) => step.with?.path?.includes(".agents/tmp/test-results/")),
      name,
    ).toBe(false);
  }
  expect(
    workflow.jobs["debugger-core"]?.steps.find(
      (step) => step.name === "Run flaky debugger integration",
    )?.run,
  ).toContain("tests/integration/debugger*.integration.test.ts");
  expect(
    workflow.jobs["validate-windows-core"]?.steps.find(
      (step) => step.name === "Run flaky Windows debugger lifecycle",
    )?.["continue-on-error"],
  ).toBe(true);
  expect(
    workflow.jobs["validate-windows-core"]?.steps.find(
      (step) => step.name === "Run Windows AST checks",
    )?.["continue-on-error"],
  ).not.toBe(true);
});
test("retains failures while every integration shard runs on its own runner", () => {
  const root = findRepositoryRoot(import.meta.url);
  const workflow = parse(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const job = (name: string): WorkflowJob => {
    const selected = workflow.jobs[name];
    if (selected === undefined) throw new Error(`Missing CI job: ${name}`);
    return selected;
  };
  const find = (jobName: string, name: string) => {
    const steps = job(jobName).steps;
    const index = steps.findIndex((entry) => entry.name === name);
    const step = steps[index];
    if (step === undefined) throw new Error(`Missing CI step: ${jobName}/${name}`);
    return { index, step };
  };
  const unit = find("validate", "Run unit tests");
  const upload = find("validate", "Upload unit test report");
  const report = find("validate", "Report unit tests");
  expect(upload.index).toBe(unit.index + 1);
  expect(upload.step.if).toBe(
    "needs.plan.outputs.full == 'true' && (always() && hashFiles('.agents/tmp/test-results/unit.xml') != '')",
  );
  expect(upload.step.with?.path).toBe(".agents/tmp/test-results/unit.xml");
  expect(report.index).toBeGreaterThan(upload.index);
  const integration = job("integration");
  expect(integration.needs).toBe("plan");
  expect(integration.if).toContain("needs.plan.outputs.full == 'true'");
  expect(integration.strategy).toEqual({
    "fail-fast": false,
    matrix: { shard: [1, 2, 3, 4] },
  });
  const shard = find("integration", "Run integration shard");
  expect(shard.step.run).toBe('bash scripts/test-integration-ci.sh "${{ matrix.shard }}/4"');
  expect(shard.step.if).toBeUndefined();
  expect(find("integration-namespaces", "Run namespace integration tests").step.run).toContain(
    "sudo env",
  );
  expect(find("integration-namespaces", "Run namespace integration tests").step.run).toContain(
    "scripts/test-integration-ci.sh namespaces",
  );
  for (const job of ["validate", "integration", "integration-namespaces"]) {
    expect(find(job, "Setup Linux tests").step.uses).toBe("./.github/actions/setup-linux-tests");
  }
  for (const job of ["integration", "integration-namespaces"]) {
    const logs = find(job, "Upload integration shard logs");
    const report = find(job, "Upload integration report");
    expect(logs.step.if).toBe("always()");
    expect(logs.step.with?.["include-hidden-files"]).toBe(true);
    expect(logs.step.with?.path).toBe(".tmp/integration-ci/*.log");
    expect(report.step.if).toBe("always()");
    expect(report.step.with?.path).toBe(".agents/tmp/test-results/integration-*.xml");
  }
  const aggregate = job("integration-report");
  expect(aggregate.needs).toEqual(["plan", "integration", "integration-namespaces"]);
  expect(aggregate.if).toContain("always()");
  expect(aggregate.if).toContain("needs.plan.outputs.full == 'true'");
  expect(find("integration-report", "Checkout").index).toBeLessThan(
    find("integration-report", "Download integration reports").index,
  );
  const integrationReport = find("integration-report", "Report integration tests");
  expect(integrationReport.step.with?.path).toBe(".agents/tmp/test-results/integration-*.xml");
  expect(integrationReport.step.if).toBe(
    "always() && hashFiles('.agents/tmp/test-results/integration-*.xml') != ''",
  );
  for (const name of ["Retain failed anchor Pi traces", "Retain failed composition Pi traces"]) {
    const retained = find("integration", name);
    expect(retained.index).toBeGreaterThan(shard.index);
    expect(retained.step.if).toBe("failure()");
    expect(retained.step.with?.["include-hidden-files"]).toBe(true);
  }
  const candidate = find("validate", "Build and install reproducible release candidate");
  expect(candidate.index).toBeGreaterThan(report.index);
  expect(candidate.step.if).toContain("success()");
  expect(candidate.step.if).toContain("needs.plan.outputs.full == 'true'");
  const windowsSteps = job("validate-windows-core").steps.filter((entry) =>
    [
      "Verify Windows Pi 0.99.1 source and native tools",
      "Verify Windows installed package and host boundaries",
    ].includes(entry.name),
  );
  const windowsTraces = job("validate-windows-core").steps.find(
    (entry) => entry.name === "Retain Windows host traces",
  );
  expect(windowsTraces?.if).toBe("always()");
  expect(windowsTraces?.with?.["include-hidden-files"]).toBe(true);
  expect(windowsTraces?.with?.path).toContain("native-host.integration.test.ts/");
  expect(windowsTraces?.with?.path).toContain("lazy-builtins.integration.test.ts/");
  expect(windowsSteps).toHaveLength(2);
  for (const step of windowsSteps) {
    expect(step.run).toContain("env -u PI_INTEGRATION_TEST_RUNNER pnpm exec vitest");
    expect(step.run).not.toContain("pi-test run");
  }
});

test("the required Validate check fails instead of being skipped when planning fails", () => {
  const workflow = parse(
    readFileSync(
      path.join(findRepositoryRoot(import.meta.url), ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as { jobs: Record<string, WorkflowJob> };
  const job = workflow.jobs.validate;
  expect(job?.name).toBe("Validate");
  expect(job?.needs).toContain("plan");
  expect(job?.if).toContain("always()");
  const guard = job?.steps.find((step) => step.name === "Require a valid CI plan");
  expect(guard?.run).toBeDefined();
  if (!guard?.run) throw Error("Missing required-check guard");
  for (const [result, full, event, nightly, accepted] of [
    ["failure", "false", "push", "false", false],
    ["skipped", "true", "pull_request", "false", false],
    ["success", "", "push", "false", false],
    ["success", "false", "pull_request", "false", false],
    ["success", "false", "push", "true", false],
    ["success", "true", "pull_request", "false", true],
    ["success", "false", "push", "false", true],
  ] as const) {
    const run = spawnSync("bash", ["-c", guard.run], {
      env: {
        ...process.env,
        PLAN_RESULT: result,
        RUN_FULL: full,
        CI_EVENT: event,
        CI_NIGHTLY: nightly,
      },
    });
    expect(run.status === 0, `${result}/${full}/${event}/${nightly}`).toBe(accepted);
  }
});

test("runs each configured-startup and interface check once and records only full core runs", () => {
  const workflow = parse(
    readFileSync(
      path.join(findRepositoryRoot(import.meta.url), ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as { jobs: Record<string, WorkflowJob> };
  const validate = workflow.jobs.validate;
  for (const name of [
    "Verify normal configured startup",
    "Capture agent interface",
    "Retain agent interface",
  ]) {
    expect(
      validate?.steps.filter((step) => step.name === name),
      name,
    ).toHaveLength(1);
  }
  for (const name of [
    "Setup Linux tests",
    "Run unit tests",
    "Build and install reproducible release candidate",
  ]) {
    expect(validate?.steps.find((step) => step.name === name)?.if, name).toContain(
      "needs.plan.outputs.full == 'true'",
    );
  }
  expect(validate?.steps.find((step) => step.name === "Scan commit range")?.if).toBeUndefined();
  const record = workflow.jobs["record-evidence"];
  expect(record?.needs).toEqual([
    "plan",
    "validate",
    "validate-windows-core",
    "integration",
    "integration-namespaces",
    "integration-report",
  ]);
  expect(record?.if).toContain("needs.plan.outputs.full == 'true'");
  expect(record?.if).toContain("needs.validate.result == 'success'");
  expect(record?.if).toContain("needs['validate-windows-core'].result == 'success'");
  for (const name of ["integration", "integration-namespaces", "integration-report"]) {
    expect(record?.needs).toContain(name);
    expect(record?.if).toContain(
      name === "integration"
        ? "needs.integration.result == 'success'"
        : `needs['${name}'].result == 'success'`,
    );
  }
  expect(workflow.jobs["validate-windows-core"]?.if).toContain("needs.plan.outputs.full == 'true'");
});
