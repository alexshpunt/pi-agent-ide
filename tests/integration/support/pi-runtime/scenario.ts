import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { diffLines } from "diff";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  type PiIntegrationTestResult,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect } from "vitest";

interface TextToolScenario {
  readonly extensions: readonly string[];
  readonly cwd: string;
  readonly testName: string;
  readonly tool: "write" | "insert" | "replace" | "delete" | "copy" | "move";
  readonly tools?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly isolateUserResources?: boolean;
  /** Use native panels when checking the user-facing diff instead of raw tool text. */
  readonly rawMode?: boolean;
  readonly arguments: Record<string, unknown>;

  /** Views requested after the edit when the scenario verifies explicit inspection. */
  readonly postflightViews?: readonly string[];

  /** Views requested before the edit when the scenario needs view-specific anchors. */
  readonly preflightViews?: readonly string[];
}

export interface TextToolScenarioResult {
  readonly result: PiIntegrationTestResult;
  readonly mutationCallId: string;
  readonly preflightCallIds: readonly string[];
  readonly postflightCallIds: readonly string[];
  readonly beforeContents: Readonly<Record<string, string>>;
  readonly afterContents: Readonly<Record<string, string>>;
}

export async function runTextToolScenario(
  scenario: TextToolScenario,
): Promise<TextToolScenarioResult> {
  const testPath = expect.getState().testPath;

  if (testPath === undefined) {
    throw new Error("Cannot determine the current integration test file");
  }

  const files = editedFiles(scenario.arguments);
  const captureContents = async () =>
    Object.fromEntries(
      await Promise.all(
        files.map(
          async (file) => [file, await readFile(resolve(scenario.cwd, file), "utf8")] as const,
        ),
      ),
    );
  const beforeContents = await captureContents();
  const preflightCallIds = files.map((_file, index) => `${scenario.testName}-read-before-${index}`);
  const postflightCallIds = files.map((_file, index) => `${scenario.testName}-read-after-${index}`);
  const mutationCallId = `${scenario.testName}-${scenario.tool}`;
  const conversation = [
    ...files.map((file, index) =>
      readMessage(preflightCallIds[index], file, scenario.preflightViews),
    ),
    assistantMessage(
      [toolCall({ id: mutationCallId, name: scenario.tool, arguments: scenario.arguments })],
      { stopReason: "toolUse" },
    ),
    ...files.map((file, index) =>
      readMessage(postflightCallIds[index], file, scenario.postflightViews),
    ),
    assistantMessage([text(`The ${scenario.tool} operation finished`)]),
  ];
  const result = await new PiIntegrationTest({
    testName: scenario.testName,
    cwd: scenario.cwd,
    extensions: scenario.extensions,
    tools: scenario.tools ?? [scenario.tool, "read"],
    ...(scenario.rawMode === undefined ? {} : { rawMode: scenario.rawMode }),

    ...(scenario.environment === undefined ? {} : { environment: scenario.environment }),
    ...(scenario.isolateUserResources === undefined
      ? {}
      : { isolateUserResources: scenario.isolateUserResources }),
    conversation,
    artifactsDir: testArtifactsDir(testPath),
  }).run(`Run one ${scenario.tool} operation`);

  for (const callId of [...preflightCallIds, ...postflightCallIds]) {
    expect(getToolExecution(result, callId).isError, callId).toBe(false);
  }

  const afterContents = await captureContents();
  return {
    result,
    mutationCallId,
    preflightCallIds,
    postflightCallIds,
    beforeContents,
    afterContents,
  };
}

export function expectTextToolDiff(
  scenario: TextToolScenarioResult,
  path: string,
  before: string,
  after: string,
  presentation: "agent" | "tui" = "agent",
): void {
  const expected = expectedDiff(before, after);
  const output =
    presentation === "tui"
      ? scenario.result.tuiRenderedOutput
      : getToolResultText(scenario.result, scenario.mutationCallId);
  const lines = output.split("\n");

  expect(lines.slice(1).some((line) => /^[+ -]\|/u.test(line))).toBe(false);

  for (const line of expected.added.filter((value) => value.length > 0)) {
    expect(lines.some((rendered) => rendered.includes(line))).toBe(true);
  }

  const details = getToolExecutionDetails(
    getToolExecution(scenario.result, scenario.mutationCallId),
  );
  const data = getTextToolMutationData(details);
  expect(data).toMatchObject({
    addedLines: expected.added.length,
    removedLines: expected.removed.length,
  });
  expect(scenario.beforeContents[path]).toBe(before);
  expect(scenario.afterContents[path]).toBe(after);
  // RPC receipts retain counts, not engine snapshots or unbounded diff payloads.
  for (const field of ["beforeContentMap", "afterContent", "afterDocument", "snapshot", "diffs"]) {
    expect(data).not.toHaveProperty(field);
  }
}

function expectedDiff(
  before: string,
  after: string,
): { readonly added: string[]; readonly removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];

  for (const part of diffLines(before, after)) {
    const values = part.value.replaceAll("\r\n", "\n").split("\n");

    if (values.at(-1) === "") {
      values.pop();
    }

    if (part.added) {
      added.push(...values);
    } else if (part.removed) {
      removed.push(...values);
    }
  }

  return { added, removed };
}

export function getTextToolMutationData(details: unknown): Record<string, unknown> {
  if (typeof details !== "object" || details === null) {
    throw new TypeError("Text tool result has no structured details");
  }

  const results = (details as { readonly results?: unknown }).results;
  const first: unknown = Array.isArray(results) ? (results as readonly unknown[])[0] : undefined;

  if (typeof first !== "object" || first === null) {
    throw new TypeError("Text tool result has no mutation result");
  }

  const data = (first as { readonly data?: unknown }).data;

  if (typeof data !== "object" || data === null) {
    throw new TypeError("Text tool result has no mutation data");
  }

  return data as Record<string, unknown>;
}

function editedFiles(arguments_: Record<string, unknown>): readonly string[] {
  const files = new Set<string>();

  for (const key of ["path", "target"]) {
    const value = arguments_[key];

    if (typeof value === "string" && value.length > 0) {
      files.add(value);
    }
  }

  return [...files];
}

function readMessage(id: string | undefined, file: string, views: readonly string[] = ["anchors"]) {
  if (id === undefined) throw new Error("Missing Read call ID");
  return assistantMessage(
    [
      toolCall({
        id,
        name: "read",
        arguments: { path: file, offset: 1, views },
      }),
    ],
    { stopReason: "toolUse" },
  );
}
