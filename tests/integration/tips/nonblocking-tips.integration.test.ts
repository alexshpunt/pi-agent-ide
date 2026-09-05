import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const workspaces: string[] = [];
const extensions = [
  path.resolve("tests/integration/fixtures/slow-tip-provider.ts"),
  path.resolve("src/tips/extension.ts"),
];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = testArtifactsDir(import.meta.filename);
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  workspaces.push(cwd);
  return cwd;
}

test("the agent can use tools while a tip is pending, then see its late result", async () => {
  const cwd = await workspace();
  const result = await new PiIntegrationTest({
    testName: "nonblocking-tip-ready",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions,
    isolateUserResources: true,
    tools: ["release_tip"],
    rawMode: false,
    conversation: [
      assistantMessage([toolCall({ id: "release", name: "release_tip", arguments: {} })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("The pending tip did not block this turn.")]),
    ],
  }).run("Release the pending startup tip");
  expect(getToolExecution(result, "release").isError).toBe(false);
  expect(result.tuiRenderedOutput).toContain("Slow startup tip");
  expect(JSON.stringify(result.providerRequests)).not.toContain(
    "The session was ready before this inspection finished.",
  );
});

test("reload discards the previous pending tip and lets the new session show its own", async () => {
  const cwd = await workspace();
  const result = await new PiIntegrationTest({
    testName: "nonblocking-tip-reload",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions,
    isolateUserResources: true,
    tools: ["release_tip"],
    rawMode: false,
    conversation: [
      assistantMessage([toolCall({ id: "release", name: "release_tip", arguments: {} })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Reload completed.")]),
    ],
  }).run("/tips-reload");
  expect(getToolExecution(result, "release").isError).toBe(false);
  expect(result.tuiRenderedOutput).toContain("Slow startup tip");
  expect(result.tuiRenderedOutput).not.toContain("Late forbidden tip");
  expect(JSON.stringify(result.messages)).not.toContain("Late forbidden tip");
});

test("shutdown cancels a pending provider and ignores its late result", async () => {
  const cwd = await workspace();
  const result = await new PiIntegrationTest({
    testName: "nonblocking-tip-shutdown",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions,
    isolateUserResources: true,
    tools: [],
    rawMode: false,
    conversation: [assistantMessage([text("Finish without waiting for the tip.")])],
  }).run("Finish immediately");
  expect(await readFile(path.join(cwd, "tip-aborted.txt"), "utf8")).toBe("aborted");
  expect(result.tuiRenderedOutput).not.toContain("Late forbidden tip");
  expect(JSON.stringify(result.messages)).not.toContain("Late forbidden tip");
});
