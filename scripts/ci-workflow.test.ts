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
}

interface WorkflowJob {
  steps: WorkflowStep[];
  needs?: string[];
  if?: string;
  strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
}

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
  expect(upload.step.if).toBe("always() && hashFiles('.agents/tmp/test-results/unit.xml') != ''");
  expect(upload.step.with?.path).toBe(".agents/tmp/test-results/unit.xml");
  expect(report.index).toBeGreaterThan(upload.index);
  const integration = job("integration");
  expect(integration.needs).toBeUndefined();
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
  expect(aggregate.needs).toEqual(["integration", "integration-namespaces"]);
  expect(aggregate.if).toBe("always()");
  expect(find("integration-report", "Checkout").index).toBeLessThan(
    find("integration-report", "Download integration reports").index,
  );
  const integrationReport = find("integration-report", "Report integration tests");
  expect(integrationReport.step.with?.path).toBe(".agents/tmp/test-results/integration-*.xml");
  expect(integrationReport.step.if).toBe(
    "always() && hashFiles('.agents/tmp/test-results/integration-*.xml') != ''",
  );
  const candidate = find("validate", "Build and install reproducible release candidate");
  expect(candidate.index).toBeGreaterThan(report.index);
  expect(candidate.step.if).toMatch(/^success\(\)/u);
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
