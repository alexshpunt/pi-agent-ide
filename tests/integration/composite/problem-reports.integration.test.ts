import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, expect, test } from "vitest";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";

const root = path.resolve(".agents", "tmp", "problem-reports-integration");
const extension = path.resolve("src", "pi-agent-ide.ts");
const restoreSharedRunner = forceStandaloneIntegrationFile();

beforeAll(async () => {
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  restoreSharedRunner();
});

/** An agent folder whose crash log holds one recent crash inside the Pi Agent IDE package. */
async function agentWithCrash(message: string, flags?: Record<string, boolean>) {
  const agentDirectory = await mkdtemp(path.join(root, "agent-"));
  const frame = pathToFileURL(path.resolve("src", "core", "ide-core.ts")).href;
  await writeFile(
    path.join(agentDirectory, "crashes.json"),
    JSON.stringify([
      {
        timestamp: new Date().toISOString(),
        version: "1.6.0",
        kind: "uncaught_exception",
        message,
        stack: `TypeError: ${message}\n    at registerPlugin (${frame}:82:31)`,
        sessionFile: null,
        cwd: root,
      },
    ]),
  );
  if (flags) {
    await mkdir(path.join(agentDirectory, "pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(agentDirectory, "pi-agent-ide", "extensions.json"),
      JSON.stringify({ disabled: [], flags }),
    );
  }
  return agentDirectory;
}

async function run(testName: string, agentDirectory: string) {
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  return new PiIntegrationTest({
    testName,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [extension],
    tools: [],
    rawMode: false,
    // The crash log and IDE settings live in the agent folder this test prepares.
    isolateUserResources: false,
    environment: { PI_CODING_AGENT_DIR: agentDirectory },
    conversation: [assistantMessage([text("Ready")])],
  }).run("Hello");
}

/**
 * The prefilled new-issue links the run drew. The panel is cleared when the session ends, so the
 * terminal stream holds it, not the final screen. Pi's own crash notice names the message too.
 */
function offeredIssues(output: string): string[] {
  const links = output.match(
    /github\.com\/alexshpunt\/pi-agent-ide\/issues\/new\?[^\u0007\u001b]*/gu,
  );
  return [...new Set(links ?? [])];
}

test("a recent Pi crash inside Pi Agent IDE is offered as an issue once", async () => {
  const message = "fixture crash 7f3a in the read module";
  const agentDirectory = await agentWithCrash(message);

  const first = await run("problem-report-crash", agentDirectory);
  expect(first.exitCode).toBe(0);
  const offered = offeredIssues(first.terminalOutput);
  expect(offered).toHaveLength(1);
  expect(offered[0]).toContain(encodeURIComponent(message));

  const second = await run("problem-report-crash-again", agentDirectory);
  expect(second.exitCode).toBe(0);
  expect(offeredIssues(second.terminalOutput)).toEqual([]);
});

test("with problem reports turned off, no panel appears", async () => {
  const agentDirectory = await agentWithCrash("fixture crash 91bc while reports are off", {
    "pi-agent-ide-problem-reports": false,
  });

  const result = await run("problem-report-off", agentDirectory);
  expect(result.exitCode).toBe(0);
  expect(offeredIssues(result.terminalOutput)).toEqual([]);
});
