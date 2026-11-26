import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  PiIntegrationTest,
  assistantMessage,
  toolCall,
  text,
  getToolExecution,
  getToolExecutionResult,
  getToolResultText,
  testArtifactsDir,
} from "pi-coding-agent-test";

let workspace: string | undefined;
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});
const live =
  process.env.PI_UNITY_CLI &&
  process.env.PI_UNITY_TEST_PROJECT_A &&
  process.env.PI_UNITY_TEST_PROJECT_B;
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

test("real Pi does not install a CLI when an explicit executable is invalid", async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "pi-unity-cli-"));
  const missing = path.join(workspace, "does-not-exist");
  const run = await new PiIntegrationTest({
    testName: "unity-install-explicit",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: workspace,
    timeoutMs: 90_000,
    extensions: [fileURLToPath(import.meta.resolve("#unity/index.ts"))],
    tools: ["unity_install_cli"],
    rawMode: false,
    environment: { PI_UNITY_CLI: missing },
    conversation: [
      assistantMessage([toolCall({ id: "install", name: "unity_install_cli", arguments: {} })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Done")]),
    ],
  }).run("Check the configured Unity CLI.");
  const execution = getToolExecution(run, "install");
  expect(execution.isError).toBe(false);
  expect(getToolResultText(run, "install")).toContain(missing);
  expect(getToolResultText(run, "install")).toContain("invalid");
  expect(run.tuiRenderedOutput).toContain("Unity CLI is unavailable");
  expect(run.tuiRenderedOutput).not.toContain('"state": "invalid"');
}, 100_000);

test.each([false, true])(
  "real Pi exposes Unity resources as typed Codemode Read values (providerFirst=%s)",
  async (providerFirst) => {
    workspace = await mkdtemp(path.join(tmpdir(), "pi-unity-codemode-"));
    const cli = path.join(workspace, "unity");
    await writeFile(
      cli,
      `#!/usr/bin/env node
console.log(JSON.stringify({ success: true, data: { instances: [{ projectPath: '/projects/Fixture', pid: 42, port: 1234, state: 'ready' }] } }));
`,
      { mode: 0o755 },
    );
    const ide = path.resolve(process.cwd(), "src/pi-agent-ide.ts");
    const unity = fileURLToPath(import.meta.resolve("#unity/index.ts"));
    const run = await new PiIntegrationTest({
      testName: `unity-codemode-values-${providerFirst}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: workspace,
      timeoutMs: 90_000,
      extensions: [...(providerFirst ? [unity, ide] : [ide, unity]), "builtin:codemode"],
      tools: ["read", "search", "codemode"],
      isolateUserResources: true,
      environment: { PI_UNITY_CLI: cli },
      conversation: [
        assistantMessage(
          [toolCall({ id: "direct", name: "read", arguments: { path: "unity://editors" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: {
                code: `
const editors = await tools.read({ path: 'unity://editors' });
if (!editors || !editors.id.startsWith('RESULT#')) throw Error('missing read id');
const data = JSON.parse(editors.text);
if (!data.some(item => item.target === 'local' && item.data.some(editor => editor.projectPath === '/projects/Fixture'))) throw Error('unexpected editors: ' + editors.text);
const missing = await tools.read({ path: 'unity://not-a-resource' });
if (missing !== null) throw Error('missing resource must return null');
text('typed Unity editors OK');`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read Unity editors.");
    expect(getToolExecution(run, "direct").isError).toBe(false);
    expect(getToolResultText(run, "direct")).toContain("/projects/Fixture");
    const output = getToolResultText(run, "script");
    expect(getToolExecution(run, "script").isError, output).toBe(false);
    expect(output).toContain("typed Unity editors OK");
    expect(output).toContain("unity://not-a-resource");
  },
  100_000,
);

const sshLive = process.env.PI_UNITY_TEST_SSH_HOST && process.env.PI_UNITY_TEST_SSH_PROJECT;
test.skipIf(!sshLive)(
  "real Pi discovers and operates on a remote Unity editor over SSH",
  async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "pi-unity-ssh-"));
    await mkdir(path.join(workspace, ".pi", "pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(workspace, ".pi", "pi-agent-ide", "ssh.json"),
      JSON.stringify({
        targets: [{ id: "test", host: process.env.PI_UNITY_TEST_SSH_HOST, workspace: "/" }],
      }),
    );
    const localCli = path.join(workspace, "local-unity");
    await writeFile(
      localCli,
      '#!/bin/sh\necho \'{"success":true,"data":{"instances":[],"items":[],"partial":false}}\'\n',
      { mode: 0o755 },
    );
    const project = `ssh://test${requiredEnv("PI_UNITY_TEST_SSH_PROJECT").split("/").map(encodeURIComponent).join("/")}`;
    const run = await new PiIntegrationTest({
      testName: "unity-ssh-live",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: workspace,
      timeoutMs: 180_000,
      extensions: [fileURLToPath(import.meta.resolve("#unity/index.ts"))],
      tools: ["unity_read", "unity_search", "unity_call"],
      environment: {
        PI_UNITY_CLI: localCli,
        ...(process.env.PI_UNITY_REMOTE_CLI
          ? { PI_UNITY_REMOTE_CLI: process.env.PI_UNITY_REMOTE_CLI }
          : {}),
      },
      conversation: [
        assistantMessage(
          [toolCall({ id: "all", name: "unity_read", arguments: { path: "unity://editors" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "editors",
              name: "unity_read",
              arguments: { path: "unity://editors/test" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "catalog",
              name: "unity_search",
              arguments: {
                path: `unity://project/${encodeURIComponent(project)}/tools`,
                query: "scene hierarchy",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "scene",
              name: "unity_call",
              arguments: { project, name: "scene_get_hierarchy", arguments: {} },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "missing",
              name: "unity_call",
              arguments: {
                project: `${project}-missing`,
                name: "scene_get_hierarchy",
                arguments: {},
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the remote Unity scene.");
    expect(getToolExecution(run, "all").isError).toBe(false);
    expect(getToolResultText(run, "all")).toContain(project);
    expect(getToolExecution(run, "editors").isError).toBe(false);
    expect(getToolResultText(run, "editors")).toContain(project);
    expect(getToolExecution(run, "catalog").isError).toBe(false);
    expect(getToolResultText(run, "catalog")).toContain("scene_get_hierarchy");
    expect(getToolExecution(run, "scene").isError).toBe(false);
    expect(getToolResultText(run, "scene")).toContain("sceneName");
    expect(getToolExecution(run, "missing").isError).toBe(true);
  },
  200_000,
);
test.skipIf(!live)(
  "real Pi addresses two live Unity editors explicitly",
  async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "pi-unity-"));
    const projectA = requiredEnv("PI_UNITY_TEST_PROJECT_A");
    const projectB = requiredEnv("PI_UNITY_TEST_PROJECT_B");
    const run = await new PiIntegrationTest({
      testName: `unity-live-routing-${process.env.PI_UNITY_TEST_RUN || "default"}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: workspace,
      timeoutMs: 180_000,
      extensions: [fileURLToPath(import.meta.resolve("#unity/index.ts"))],
      tools: ["unity_read", "unity_call"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "editors", name: "unity_read", arguments: { path: "unity://editors" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "a",
              name: "unity_call",
              arguments: { project: projectA, name: "scene_get_hierarchy", arguments: {} },
            }),
            toolCall({
              id: "b",
              name: "unity_call",
              arguments: { project: projectB, name: "scene_get_hierarchy", arguments: {} },
            }),
            toolCall({
              id: "missing",
              name: "unity_call",
              arguments: {
                project: "C:\\definitely-missing-project",
                name: "scene_get_hierarchy",
                arguments: {},
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the two explicitly named Unity projects.");
    expect(getToolExecution(run, "editors").isError).toBe(false);
    expect(getToolResultText(run, "editors")).toContain(projectA.replaceAll("\\", "\\\\"));
    expect(getToolExecution(run, "a").isError).toBe(false);
    expect(getToolExecution(run, "b").isError).toBe(false);
    expect(getToolResultText(run, "a")).not.toEqual(getToolResultText(run, "b"));
    expect(getToolExecution(run, "missing").isError).toBe(true);
  },
  180_000,
);

test.skipIf(!live)(
  "real Pi registers individual deferred tools after discovery",
  async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "pi-unity-tools-"));
    const project = requiredEnv("PI_UNITY_TEST_PROJECT_B");
    const run = await new PiIntegrationTest({
      testName: "unity-dynamic-tools",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: workspace,
      timeoutMs: 180_000,
      extensions: [
        fileURLToPath(import.meta.resolve("#unity/index.ts")),
        path.resolve(import.meta.dirname, "activate-dynamic.ts"),
      ],
      tools: ["unity_search", "unity_read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "tools",
              name: "unity_search",
              arguments: {
                path: `unity://project/${encodeURIComponent(project)}/tools`,
                query: "scene hierarchy",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "schema",
              name: "unity_read",
              arguments: {
                path: `unity://project/${encodeURIComponent(project)}/tools/scene_get_hierarchy`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "missing",
              name: "unity_search",
              arguments: {
                path: `unity://project/${encodeURIComponent("C:\\definitely-missing-project")}/tools`,
                query: "scene",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "scene",
              name: "unity_scene_get_hierarchy",
              arguments: { project, arguments: {} },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Discover and read a Unity scene.");
    expect(getToolExecution(run, "tools").isError).toBe(false);
    expect(getToolResultText(run, "tools")).toContain("scene_get_hierarchy");
    expect(getToolExecution(run, "schema").isError).toBe(false);
    const schemaResult = getToolExecutionResult(run, "schema") as { script: { content: string } };
    const schema = JSON.parse(schemaResult.script.content) as {
      name: string;
      inputSchema: { type: string };
    };
    expect(schema.name).toBe("scene_get_hierarchy");
    expect(schema.inputSchema.type).toBe("object");
    expect(getToolExecution(run, "missing").isError).toBe(true);
    expect(getToolExecution(run, "scene").isError).toBe(false);
    expect(getToolResultText(run, "scene")).toContain("sceneName");
  },
  200_000,
);

test.skipIf(!live)(
  "real Pi IDE shared read and search handle Unity resources",
  async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "pi-unity-ide-"));
    const name = requiredEnv("PI_UNITY_TEST_PROJECT_B").split(/[\\/]/).findLast(Boolean);
    if (!name) throw new Error("Project path has no name");
    const ide = path.resolve(process.cwd(), "src/pi-agent-ide.ts");
    const unity = fileURLToPath(import.meta.resolve("#unity/index.ts"));
    const run = await new PiIntegrationTest({
      testName: `unity-ide-resources-${process.env.PI_UNITY_REVERSE_LOAD ? "reverse" : "normal"}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: workspace,
      timeoutMs: 180_000,
      extensions: process.env.PI_UNITY_REVERSE_LOAD ? [unity, ide] : [ide, unity],
      tools: ["read", "search", "bash"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "read", name: "read", arguments: { path: "unity://editors" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "search",
              name: "search",
              arguments: { path: "unity://editors", query: name },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "catalog",
              name: "search",
              arguments: {
                path: `unity://project/${encodeURIComponent(requiredEnv("PI_UNITY_TEST_PROJECT_B"))}/tools`,
                query: "scene hierarchy",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "schema",
              name: "read",
              arguments: {
                path: `unity://project/${encodeURIComponent(requiredEnv("PI_UNITY_TEST_PROJECT_B"))}/tools/scene_get_hierarchy`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read and search Unity editor discovery.");
    expect(getToolExecution(run, "read").isError).toBe(false);
    expect(getToolResultText(run, "read")).toContain(name);
    expect(getToolExecution(run, "search").isError).toBe(false);
    expect(getToolResultText(run, "search")).toContain(name);
    expect(getToolExecution(run, "catalog").isError).toBe(false);
    expect(getToolResultText(run, "catalog")).toContain("scene_get_hierarchy");
    expect(getToolExecution(run, "schema").isError).toBe(false);
    const schemaResult = getToolExecutionResult(run, "schema") as { script: { content: string } };
    const schema = JSON.parse(schemaResult.script.content) as { name: string };
    expect(schema.name).toBe("scene_get_hierarchy");
  },
  200_000,
);
