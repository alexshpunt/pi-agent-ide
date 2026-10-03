import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

interface WorkflowStep {
  name: string;
  if?: string;
  with?: { name?: string; path?: string };
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
});
