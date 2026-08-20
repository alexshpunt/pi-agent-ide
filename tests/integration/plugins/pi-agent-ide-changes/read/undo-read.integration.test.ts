import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const runFile = promisify(execFile);
const generatedExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  path.resolve(
    "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts",
  ),
  "src/plugins/pi-agent-ide-changes/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-ide-changes");
const supportRoot = path.resolve("tests/integration/plugins/pi-agent-ide-changes/read/support");

interface RepositoryFixture {
  readonly directory: string;
  readonly fileName: string;
}

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("read shows complex TypeScript changes as independent undo groups", async () => {
  await withRepository(async ({ directory, fileName }) => {
    const baseline = await committedSource();
    const current = await changedSource();

    await writeFile(path.join(directory, fileName), current, "utf8");

    const result = await runReads(directory, "undo-read-complex-typescript", [
      readCall("changed", fileName),
    ]);
    const rendered = getToolResultText(result, "changed");
    const anchors = rendered.match(/CHANGE#[A-Z0-9]+/gu) ?? [];

    expect(new Set(anchors).size).toBeGreaterThanOrEqual(6);
    expectInlineHunk(rendered, "const normalizedFiles = [...new Set(files)].sort();", [
      "files: [...files]",
      'priority: "normal"',
      "files: normalizedFiles",
      'priority: normalizedFiles.length > 8 ? "high" : "normal"',
      "tags: []",
    ]);
    expectInlineHunk(rendered, "export function appendRunMessages", [
      "messages: readonly string[]",
      "messages: [...run.messages, ...messages]",
    ]);
    expectInlineHunk(rendered, "retry budget exhausted", [
      "return run;",
      'appendRunMessage(run, "retry budget exhausted")',
      "attempts: run.attempts - 1",
    ]);
    expectInlineHunk(rendered, "describeLegacyTask", [
      "export function describeLegacyTask",
      "const fileList",
      "const priority",
      "const heading",
      "`files=${fileList}`",
    ]);
    expect(baseline).toContain("export function describeLegacyTask");
    expectInlineHunk(rendered, "`durationMs=${duration}`", [
      "`duration=${duration}`",
      "`durationMs=${duration}`",
      "`priority=${run.task.priority}`",
    ]);
    expectInlineHunk(rendered, "run completed", [
      'return appendRunMessage(run, "run closed")',
      'appendRunMessages(run, ["run completed"',
      "export function formatDebugRun",
      "return JSON.stringify(run, undefined, 2)",
    ]);
    expect(rendered).toContain("1#");
    expect(rendered).toContain(`${current.trimEnd().split("\n").length}#`);
  });
}, 60_000);

test("pagination keeps the deletion-only change anchor from the complete file", async () => {
  await withRepository(async ({ directory, fileName }) => {
    const current = await changedSource();
    const marker = "export function selectNextTask";
    const markerLine = lineNumberOf(current, marker);
    const deletionLine = markerLine;
    await writeFile(path.join(directory, fileName), current, "utf8");

    const result = await runReads(directory, "undo-read-pagination", [
      readCall("full", fileName),
      readCall("page", fileName, { offset: deletionLine, limit: 1 }),
    ]);
    const fullAnchor = anchorOnLineNumber(getToolResultText(result, "full"), deletionLine);
    const pageAnchor = anchorOnLineNumber(getToolResultText(result, "page"), deletionLine);

    expect(fullAnchor).toBeDefined();
    expect(pageAnchor).toBe(fullAnchor);
  });
}, 60_000);

test("read refreshes anchors from the current file and skips clean and untracked files", async () => {
  await withRepository(async ({ directory, fileName }) => {
    const untrackedFile = "untracked.ts";
    await writeFile(path.join(directory, untrackedFile), "export const value = 1;\n", "utf8");
    await writeFile(path.join(directory, fileName), await changedSource(), "utf8");

    const changed = await runReads(directory, "undo-read-changed", [readCall("changed", fileName)]);
    const firstAnchor = getToolResultText(changed, "changed").match(/CHANGE#[A-Z0-9]+/u)?.[0];
    expect(firstAnchor).toBeDefined();

    await writeFile(path.join(directory, fileName), await secondChangedSource(), "utf8");
    const refreshed = await runReads(directory, "undo-read-refreshed", [
      readCall("refreshed", fileName),
    ]);
    const refreshedAnchor = getToolResultText(refreshed, "refreshed").match(
      /CHANGE#[A-Z0-9]+/u,
    )?.[0];
    expect(refreshedAnchor).toBeDefined();
    expect(refreshedAnchor).not.toBe(firstAnchor);

    await writeFile(path.join(directory, fileName), await committedSource(), "utf8");
    const ordinary = await runReads(directory, "undo-read-ordinary", [
      readCall("clean", fileName),
      readCall("untracked", untrackedFile),
    ]);
    expect(getToolResultText(ordinary, "clean")).not.toContain("CHANGE#");
    expect(getToolResultText(ordinary, "untracked")).not.toContain("CHANGE#");
  });
}, 60_000);

test("undo restores one read change and leaves unrelated changes visible", async () => {
  await withRepository(async ({ directory, fileName }) => {
    const baseline = await committedSource();
    const current = await changedSource();
    const selector = selectorForCurrentMarker(
      fileName,
      baseline,
      current,
      "const DEFAULT_ATTEMPTS = 3;",
    );
    await writeFile(path.join(directory, fileName), current, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "undo-tool-selective",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["undo", "read"],
      rawMode: false,
      conversation: [
        assistantMessage([readCall("before", fileName)], { stopReason: "toolUse" }),
        assistantMessage(
          [
            toolCall({
              id: "undo-selected",
              name: "undo",
              arguments: { file: fileName, change: selector },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([readCall("after", fileName)], { stopReason: "toolUse" }),
        assistantMessage([text("The selective undo check finished")]),
      ],
    }).run("Undo the selected current Git change");

    expect(getToolResultText(result, "before")).toContain(selector);
    expect(getToolExecution(result, "undo-selected").isError).toBe(false);
    expect(getToolResultText(result, "undo-selected")).toContain(
      "-|        |const DEFAULT_ATTEMPTS = 3;",
    );
    expect(getToolResultText(result, "undo-selected")).toMatch(
      /\+\|\s*\d+#[A-Z0-9]{4}\|const DEFAULT_ATTEMPTS = 2;/u,
    );

    const rendered = result.tuiRenderedOutput;
    const header = `undo ${fileName}:${selector} +0 ~1 -0`;
    const panelStart = rendered.indexOf("╭─", rendered.indexOf(header));
    const panelEnd = rendered.indexOf("╯", panelStart);
    const panel = rendered.slice(panelStart, panelEnd + 1);

    expect(rendered).toContain(header);
    expect(panelStart).toBeGreaterThan(-1);
    expect(panel).toMatch(/\d+\s+~\s+const DEFAULT_ATTEMPTS = 2;/u);
    expect(panel).not.toContain("const DEFAULT_ATTEMPTS = 3;");

    const content = await readFile(path.join(directory, fileName), "utf8");
    expect(content).toContain("const DEFAULT_ATTEMPTS = 2;");
    expect(content).toContain('readonly priority: "low" | "normal" | "high" | "urgent";');
    expect(getToolResultText(result, "after")).not.toContain(selector);
    expect(getToolResultText(result, "after")).toContain("CHANGE#");
  });
}, 60_000);

test("batched undo calls inherit the file and restore independent read changes", async () => {
  await withRepository(async ({ directory, fileName }) => {
    const baseline = await committedSource();
    const current = await changedSource();
    const attemptsSelector = selectorForCurrentMarker(
      fileName,
      baseline,
      current,
      "const DEFAULT_ATTEMPTS = 3;",
    );
    const filesSelector = selectorForCurrentMarker(
      fileName,
      baseline,
      current,
      "const normalizedFiles = [...new Set(files)].sort();",
    );
    expect(filesSelector).not.toBe(attemptsSelector);
    await writeFile(path.join(directory, fileName), current, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "undo-tool-batch-inheritance",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["undo", "read"],
      conversation: [
        assistantMessage([readCall("before", fileName)], { stopReason: "toolUse" }),
        assistantMessage(
          [
            toolCall({
              id: "undo-attempts",
              name: "undo",
              arguments: { file: fileName, change: attemptsSelector },
            }),
            toolCall({
              id: "undo-files",
              name: "undo",
              arguments: { change: filesSelector },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The batched undo check finished")]),
      ],
    }).run("Undo two independent current Git changes");

    expect(getToolResultText(result, "before")).toContain(attemptsSelector);
    expect(getToolResultText(result, "before")).toContain(filesSelector);
    expect(getToolExecution(result, "undo-attempts").isError).toBe(false);
    expect(getToolExecution(result, "undo-files").isError).toBe(false);
    expect(getToolResultText(result, "undo-attempts")).toContain(fileName);
    expect(getToolResultText(result, "undo-files")).toContain(fileName);

    const content = await readFile(path.join(directory, fileName), "utf8");
    expect(content).toContain("const DEFAULT_ATTEMPTS = 2;");
    expect(content).not.toContain("const normalizedFiles = [...new Set(files)].sort();");
    expect(content).toContain('readonly priority: "low" | "normal" | "high" | "urgent";');
  });
}, 60_000);

function readCall(
  id: string,
  fileName: string,
  range: { offset: number; limit: number } | undefined = undefined,
) {
  return toolCall({
    id,
    name: "read",
    arguments: { path: fileName, ...range },
  });
}

async function runReads(
  directory: string,
  testName: string,
  calls: readonly ReturnType<typeof readCall>[],
) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName,
    cwd: directory,
    extensions: generatedExtensions.paths,
    tools: ["read"],
    conversation: [
      ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" as const })),
      assistantMessage([text("The undo read check finished")]),
    ],
  }).run("Read current Git changes");
}

async function withRepository(
  callback: (fixture: RepositoryFixture) => Promise<void>,
): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "repository-"));
  const fileName = "tracked.ts";

  try {
    await runFile("git", ["init", "--quiet"], { cwd: directory });
    await runFile("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    await runFile("git", ["config", "user.name", "Test"], { cwd: directory });
    await writeFile(path.join(directory, fileName), await committedSource(), "utf8");
    await runFile("git", ["add", fileName], { cwd: directory });
    await runFile("git", ["commit", "--quiet", "-m", "base"], { cwd: directory });
    await callback({ directory, fileName });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function committedSource(): Promise<string> {
  return readFile(path.join(supportRoot, "agent-workflow.baseline.ts"), "utf8");
}

async function changedSource(): Promise<string> {
  return readFile(path.join(supportRoot, "agent-workflow.changed.ts"), "utf8");
}

async function secondChangedSource(): Promise<string> {
  return (await changedSource()).replace(
    'readonly priority: "low" | "normal" | "high" | "urgent";',
    'readonly priority: "low" | "normal" | "high" | "urgent" | "blocked";',
  );
}

function lineNumberOf(content: string, marker: string): number {
  return content.split("\n").findIndex((line) => line.startsWith(marker)) + 1;
}

function expectInlineHunk(
  rendered: string,
  marker: string,
  expectedFragments: readonly string[],
): void {
  const lines = rendered.split("\n");
  const markerIndex = lines.findIndex((line) => line.includes(marker));
  const beginIndex = findHunkBegin(lines, markerIndex);
  const selector = lines[beginIndex]?.match(/change-begin: (CHANGE#[A-Z0-9]+)/u)?.[1];
  const endIndex = lines.findIndex(
    (line, index) => index >= markerIndex && line.includes(`change-end: ${selector ?? "missing"}`),
  );

  expect(markerIndex, `${marker} should be visible`).toBeGreaterThanOrEqual(0);
  expect(selector, `${marker} should belong to an undo hunk`).toBeDefined();
  expect(endIndex, `${marker} hunk should have an end`).toBeGreaterThanOrEqual(markerIndex);

  const hunk = lines.slice(beginIndex, endIndex + 1).join("\n");

  for (const fragment of expectedFragments) {
    expect(hunk, `${selector} should contain ${fragment}`).toContain(fragment);
  }
}

function selectorForCurrentMarker(
  repositoryPath: string,
  baseline: string,
  current: string,
  marker: string,
): string {
  const group = createChangeGroups(repositoryPath, baseline, baseline, current).find((candidate) =>
    candidate.segments.some((segment) => segment.worktreeText.includes(marker)),
  );

  if (group === undefined) {
    throw new Error(`No undo change contains ${marker}`);
  }

  return group.selector;
}
function findHunkBegin(lines: readonly string[], fromIndex: number): number {
  for (let index = fromIndex; index >= 0; index--) {
    if (lines[index]?.includes("change-begin: CHANGE#")) {
      return index;
    }
  }

  return -1;
}

function anchorOnLineNumber(rendered: string, lineNumber: number): string | undefined {
  const lines = rendered.split("\n");
  const lineIndex = lines.findIndex((line) =>
    line.slice(2).trimStart().startsWith(`${lineNumber}#`),
  );
  const beginIndex = findHunkBegin(lines, lineIndex);
  return lines[beginIndex]?.match(/change-begin: (CHANGE#[A-Z0-9]+)/u)?.[1];
}
