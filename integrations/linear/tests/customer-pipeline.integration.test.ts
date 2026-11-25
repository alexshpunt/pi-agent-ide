import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  customer: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  issue: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
  feature: "66666666-6666-4666-8666-666666666666",
};
const request = `linear://example/customer-request/${ids.request}?project=${ids.project}`;
const issue = "linear://example/issue/ENG-12";
type Operation = [id: string, tool: string, args: Record<string, unknown>];
interface FixtureState {
  requests: { id: string; body: string; issue: string | null }[];
  issue: {
    id: string;
    uuid: string;
    projectId: string;
    status: string;
    priority: number;
    assignee: string | null;
    assigneeId: string | null;
    estimate: number | null;
    labels: string[];
  };
  calls: { operation: string; input: Record<string, unknown> }[];
}

// Pattern: the extension example drives real shared tools against a persistent CLI fixture.
// Contract: an idea becomes the same linked Triage work item; only an external human action accepts it.
test("ordinary tools preserve a customer idea through Triage and observe manual acceptance", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "customer-pipeline-"));
  const stateFile = path.join(cwd, "customer-pipeline-state.json");
  const state = async (): Promise<FixtureState> =>
    JSON.parse(await readFile(stateFile, "utf8")) as FixtureState;
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({
        axiPath: path.join(root, "tests/fixtures/customer-pipeline-axi.mjs"),
      }),
    );
    async function run(name: string, operations: Operation[]) {
      const result = await new PiIntegrationTest({
        testName: `linear-customer-pipeline-${name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        // This contract is tool behavior, not renderer layout; RPC needs no PTY or paid model.
        transport: "rpc",
        extensions: [ide.extension, path.join(root, "src/index.ts")],
        tools: ["read", "write", "insert"],
        timeoutMs: 60000,
        conversation: [
          ...operations.map(([id, tool, args]) =>
            assistantMessage([toolCall({ id, name: tool, arguments: args })], {
              stopReason: "toolUse",
            }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run(
        "Use the ordinary Linear tools for the specified customer intake operation. Do not accept the issue.",
      );
      await ide.record(result.artifacts.directory);
      for (const [id] of operations)
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      return result;
    }
    const prepared = await run("prepare", [
      ["customers", "read", { path: "linear://example/customers" }],
      ["new-request-schema", "read", { path: "linear://example/customer-request/new" }],
      [
        "create-request",
        "write",
        {
          path: "linear://example/customer-request/new",
          content: JSON.stringify({
            body: "Original customer idea",
            customer: ids.customer,
            project: "Pipeline project",
          }),
        },
      ],
      [
        "request-list",
        "read",
        { path: `linear://example/customer-requests?project=${ids.project}` },
      ],
      ["original-body", "read", { path: `${request}#body` }],
      ["edit-body", "write", { path: `${request}#body`, content: "Refined customer idea" }],
      ["refined-body", "read", { path: `${request}#body` }],
      ["unlinked", "read", { path: `${request}#issue` }],
      [
        "create-issue",
        "write",
        {
          path: "linear://example/issue/new",
          content: JSON.stringify({
            title: "Customer pipeline",
            team: "ENG",
            project: ids.project,
            state: "Triage",
            priority: 2,
            assignee: "me",
            estimate: 1,
            labels: [ids.feature],
          }),
        },
      ],
      ["link-request", "write", { path: `${request}#issue`, content: "ENG-12" }],
      ["linked", "read", { path: `${request}#issue` }],
      ["triage", "read", { path: `${issue}#status` }],
      ["initial-priority", "read", { path: `${issue}#priority` }],
      ["initial-assignee", "read", { path: `${issue}#assignee` }],
      ["initial-estimate", "read", { path: `${issue}#estimate` }],
      ["initial-labels", "read", { path: `${issue}#labels` }],
      [
        "set-metadata",
        "write",
        {
          path: `${issue}#fields`,
          content: JSON.stringify({
            priority: 3,
            assignee: ids.user,
            estimate: 0,
          }),
        },
      ],
      ["add-label", "insert", { path: `${issue}#labels`, after: "end", text: "improvement" }],
      ["changed-priority", "read", { path: `${issue}#priority` }],
      ["zero-estimate", "read", { path: `${issue}#estimate` }],
      ["combined-labels", "read", { path: `${issue}#labels` }],
      [
        "clear-metadata",
        "write",
        {
          path: `${issue}#fields`,
          content: JSON.stringify({
            assignee: null,
            estimate: null,
          }),
        },
      ],
      ["empty-assignee", "read", { path: `${issue}#assignee` }],
      ["empty-estimate", "read", { path: `${issue}#estimate` }],
    ]);
    expect(getToolResultText(prepared, "customers")).toContain("Test customer");
    expect(getToolResultText(prepared, "create-request")).toContain(request);
    expect(getToolResultText(prepared, "request-list")).toContain(request);
    expect(getToolResultText(prepared, "original-body")).toContain("Original customer idea");
    expect(getToolResultText(prepared, "refined-body")).toContain("Refined customer idea");
    expect(getToolResultText(prepared, "unlinked")).toContain("null");
    expect(getToolResultText(prepared, "linked")).toContain(ids.issue);
    expect(getToolResultText(prepared, "triage")).toContain("Triage");
    expect(getToolResultText(prepared, "initial-priority")).toMatch(/^2$/mu);
    expect(getToolResultText(prepared, "initial-assignee")).toContain("Test owner");
    expect(getToolResultText(prepared, "initial-estimate")).toMatch(/^1$/mu);
    expect(getToolResultText(prepared, "changed-priority")).toMatch(/^3$/mu);
    expect(getToolResultText(prepared, "zero-estimate")).toMatch(/^0$/mu);
    expect(getToolResultText(prepared, "initial-labels")).toContain("feature");
    expect(getToolResultText(prepared, "combined-labels")).toContain("feature");
    expect(getToolResultText(prepared, "combined-labels")).toContain("improvement");
    expect(getToolResultText(prepared, "empty-assignee")).toContain("null");
    expect(getToolResultText(prepared, "empty-estimate")).toContain("null");
    const beforeAccept = await state();
    expect(beforeAccept.requests).toEqual([
      {
        id: ids.request,
        body: "Refined customer idea",
        priority: 0,
        issue: ids.issue,
      },
    ]);
    expect(beforeAccept.issue).toMatchObject({
      id: "ENG-12",
      uuid: ids.issue,
      projectId: ids.project,
      status: "Triage",
      priority: 3,
      assignee: null,
      assigneeId: null,
      estimate: null,
      labels: ["feature", "improvement"],
    });
    const writes = beforeAccept.calls.filter((call) => call.operation.startsWith("save_"));
    expect(
      writes.filter((call) => call.operation === "save_customer_need" && !call.input.id),
    ).toHaveLength(1);
    expect(writes.filter((call) => call.operation === "save_issue" && !call.input.id)).toHaveLength(
      1,
    );
    expect(
      writes.find((call) => call.operation === "save_customer_need" && call.input.issue)?.input,
    ).toEqual({
      id: ids.request,
      issue: ids.issue,
    });
    const issueWrites = writes.filter((call) => call.operation === "save_issue");
    expect(issueWrites.map((call) => call.input.estimate)).toEqual([1, 0, undefined, null]);
    expect(issueWrites.filter((call) => Object.hasOwn(call.input, "state"))).toHaveLength(1);
    expect(issueWrites[0].input.state).toBe("Triage");
    expect(issueWrites[0].input.assignee).toBe(ids.user);
    expect(issueWrites[2].input.labels).toEqual(["feature", "improvement"]);

    // The driver represents the human clicking Accept; no agent tool performs this change.
    beforeAccept.issue.status = "Ideas";
    await writeFile(stateFile, JSON.stringify(beforeAccept, null, 2));
    const accepted = await run("after-human-accept", [
      ["backlog", "read", { path: `${issue}#status` }],
      ["same-link", "read", { path: `${request}#issue` }],
      ["same-body", "read", { path: `${request}#body` }],
    ]);
    expect(getToolResultText(accepted, "backlog")).toContain("Ideas");
    expect(getToolResultText(accepted, "same-link")).toContain(ids.issue);
    expect(getToolResultText(accepted, "same-body")).toContain("Refined customer idea");
    const afterAccept = await state();
    expect(afterAccept.requests).toEqual(beforeAccept.requests);
    expect(afterAccept.issue).toEqual(beforeAccept.issue);
    expect(afterAccept.calls.filter((call) => call.operation.startsWith("save_"))).toEqual(writes);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 150000);
