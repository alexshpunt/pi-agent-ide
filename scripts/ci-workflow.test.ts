import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

interface WorkflowJob {
  "continue-on-error"?: boolean;
  steps: WorkflowStep[];
}
interface WorkflowStep {
  name: string;
  if?: string;
  with?: { name?: string; path?: string; "include-hidden-files"?: boolean };
  env?: Record<string, string>;
  run?: string;
  "continue-on-error"?: boolean;
}

test("runs real debuggers outside blocking checks and shared CI statistics", () => {
  const workflow = parse(
    readFileSync(
      path.join(findRepositoryRoot(import.meta.url), ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as { jobs: Record<string, WorkflowJob> };
  const blocking = workflow.jobs.validate;
  expect(blocking?.["continue-on-error"]).not.toBe(true);
  const integration = blocking?.steps.find((step) => step.name === "Run integration tests");
  expect(integration?.["continue-on-error"]).not.toBe(true);
  expect(integration?.run).toContain("--exclude 'tests/integration/debugger*.integration.test.ts'");
  expect(blocking?.steps.find((step) => step.name === "Run unit tests")?.run).not.toContain(
    "--exclude",
  );
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
  const core = workflow.jobs["debugger-core"];
  expect(core?.steps.find((step) => step.name === "Run flaky debugger integration")?.run).toContain(
    "tests/integration/debugger*.integration.test.ts",
  );
  const windows = workflow.jobs["validate-windows-core"];
  expect(windows?.["continue-on-error"]).not.toBe(true);
  expect(
    windows?.steps.find((step) => step.name === "Run flaky Windows debugger lifecycle")?.[
      "continue-on-error"
    ],
  ).toBe(true);
  expect(
    windows?.steps.find((step) => step.name === "Run Windows AST checks")?.["continue-on-error"],
  ).not.toBe(true);
  const traces = blocking?.steps.find((step) => step.name === "Retain failed anchor Pi traces");
  expect(traces?.if).toBe("failure()");
  expect(traces?.with?.path).toContain("anchor-tools.integration.test.ts/");
  expect(traces?.with?.["include-hidden-files"]).toBe(true);
});

test("keeps unit failure evidence before success-only integration", () => {
  const workflow = parse(
    readFileSync(
      path.join(findRepositoryRoot(import.meta.url), ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as {
    jobs: {
      validate: { steps: WorkflowStep[] };
      "validate-windows-core": { steps: WorkflowStep[] };
    };
  };
  const steps = workflow.jobs.validate.steps;
  const find = (name: string) => {
    const index = steps.findIndex((entry) => entry.name === name);
    const step = steps[index];
    if (step === undefined) throw new Error(`Missing CI step: ${name}`);
    return { index, step };
  };
  const unit = find("Run unit tests");
  const upload = find("Upload unit test report");
  const report = find("Report unit tests");
  const integration = find("Run integration tests");

  expect(upload.index).toBe(unit.index + 1);
  expect(upload.step.if).toBe("always() && hashFiles('.agents/tmp/test-results/unit.xml') != ''");
  expect(upload.step.with?.path).toBe(".agents/tmp/test-results/unit.xml");
  expect(report.index).toBeGreaterThan(upload.index);
  expect(report.index).toBeLessThan(integration.index);
  expect(integration.step.if).toBe("success()");
  expect(integration.step.run).toBe(
    "pnpm test:integration:shards --exclude 'tests/integration/debugger*.integration.test.ts'",
  );
  expect(integration.step.env).toMatchObject({
    SHARDS: "4",
    REPORT_DIR: ".agents/tmp/test-results",
  });
  const integrationReport = find("Report integration tests");
  expect(integrationReport.step.with?.path).toBe(".agents/tmp/test-results/integration-*.xml");
  expect(integrationReport.step.if).toBe(
    "always() && hashFiles('.agents/tmp/test-results/integration-*.xml') != ''",
  );
  const logs = find("Upload integration shard logs");
  expect(logs.step.if).toBe("always()");
  expect(logs.step.with?.["include-hidden-files"]).toBe(true);
  expect(logs.step.with?.path).toBe(".tmp/integration-shards.*/*.log");
  const compositionTraces = find("Retain failed composition Pi traces");
  expect(compositionTraces.index).toBeGreaterThan(integration.index);
  expect(compositionTraces.step.if).toBe("failure()");
  expect(compositionTraces.step.with?.["include-hidden-files"]).toBe(true);
  expect(compositionTraces.step.with?.path).toBe(
    ".tmp/test-runs/tests/integration/native-tool-composition.integration.test.ts/",
  );
  const candidate = find("Build and install reproducible release candidate");
  expect(candidate.index).toBeGreaterThan(integration.index);
  expect(candidate.step.if).toMatch(/^success\(\)/u);
  const shardScript = readFileSync(
    path.join(findRepositoryRoot(import.meta.url), "scripts/test-integration-shards.sh"),
    "utf8",
  );
  // Fixtures have distinct configurations; retained shared hosts must not accumulate in CI.
  expect(shardScript).toContain("env -u PI_INTEGRATION_TEST_RUNNER pnpm exec");
  expect(shardScript).not.toContain("pnpm exec pi-test run");
  const windowsSteps = workflow.jobs["validate-windows-core"].steps.filter((entry) =>
    [
      "Verify Windows Pi 0.99.1 source and native tools",
      "Verify Windows installed package and host boundaries",
    ].includes(entry.name),
  );
  const windowsTraces = workflow.jobs["validate-windows-core"].steps.find(
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
