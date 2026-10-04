import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

interface WorkflowStep {
  name: string;
  if?: string;
  with?: { name?: string; path?: string; "include-hidden-files"?: boolean };
  env?: Record<string, string>;
  run?: string;
}

test("keeps unit failure evidence before success-only integration", () => {
  const workflow = parse(
    readFileSync(
      path.join(findRepositoryRoot(import.meta.url), ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as { jobs: { validate: { steps: WorkflowStep[] } } };
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
  expect(integration.step.run).toBe("pnpm test:integration:shards");
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
});
