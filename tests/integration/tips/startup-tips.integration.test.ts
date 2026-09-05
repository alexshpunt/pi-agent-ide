import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { afterEach, beforeEach, expect, test } from "vitest";

const workspaces: string[] = [];
const ideExtension = path.resolve("src/pi-agent-ide.ts");
const providerExtension = path.resolve("tests/integration/fixtures/tip-provider.ts");

beforeEach(async () => {
  await mkdir(testArtifactsDir(import.meta.filename), { recursive: true });
});

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("renders an eligible startup tip in the real Pi TUI without adding it to model context", async () => {
  const root = await mkdtemp(
    path.join(testArtifactsDir(import.meta.filename), "pi-agent-ide-startup-tip-"),
  );
  workspaces.push(root);
  const project = path.join(root, "project");
  const agentDirectory = path.join(root, "agent");
  await mkdir(project, { recursive: true });

  const result = await runPi({
    agentDirectory,
    project,
    testName: "startup-tip-renders",
  });

  expect(result.tuiRenderedOutput).toContain("│ PI AGENT IDE · QA startup tip");
  expect(result.tuiRenderedOutput).toContain(
    "│ Use the project tools to inspect and edit code safely.",
  );
  expect(result.providerRequests).toHaveLength(1);
  expect(JSON.stringify(result.providerRequests)).not.toContain("QA startup tip");
  expect(result.messages).toContainEqual(expect.objectContaining({ role: "assistant" }));
});

test("suppresses a displayed tip only for its project", async () => {
  const root = await mkdtemp(
    path.join(testArtifactsDir(import.meta.filename), "pi-agent-ide-startup-tip-suppression-"),
  );
  workspaces.push(root);
  const firstProject = path.join(root, "first-project");
  const secondProject = path.join(root, "second-project");
  const agentDirectory = path.join(root, "agent");
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });

  const first = await runPi({
    agentDirectory,
    project: firstProject,
    testName: "startup-tip-first-launch",
  });
  const second = await runPi({
    agentDirectory,
    project: firstProject,
    testName: "startup-tip-second-launch",
  });
  const otherProject = await runPi({
    agentDirectory,
    project: secondProject,
    testName: "startup-tip-other-project",
  });

  expect(first.tuiRenderedOutput).toContain("QA startup tip");
  expect(second.tuiRenderedOutput).not.toContain("QA startup tip");
  expect(otherProject.tuiRenderedOutput).toContain("QA startup tip");
});

test("keeps working built-ins and empty projects quiet", async () => {
  const root = await mkdtemp(
    path.join(testArtifactsDir(import.meta.filename), "doctor-tip-quiet-contract-"),
  );
  workspaces.push(root);
  const emptyProject = path.join(root, "empty-project");
  const workingProject = path.join(root, "working-project");
  const agentDirectory = path.join(root, "agent");
  await mkdir(emptyProject, { recursive: true });
  await mkdir(workingProject, { recursive: true });
  await writeFile(path.join(workingProject, "source.ts"), "export const value = 1;\n", "utf8");
  await installExecutable(agentDirectory, "rg");
  for (const executable of ["ast-grep", "oxfmt", "oxlint", "typescript-language-server"]) {
    await installExecutable(path.join(workingProject, "node_modules"), executable, ".bin");
  }

  const empty = await runPi({
    agentDirectory,
    project: emptyProject,
    testName: "doctor-tip-empty-project",
    extensions: [ideExtension],
  });
  const working = await runPi({
    agentDirectory,
    project: workingProject,
    testName: "doctor-tip-working-builtins",
    extensions: [ideExtension],
  });

  expect(empty.tuiRenderedOutput).not.toContain("Project setup");
  expect(working.tuiRenderedOutput).not.toContain("Project setup");
});

test("names an actionable setup problem and fingerprints changed state", async () => {
  const root = await mkdtemp(
    path.join(testArtifactsDir(import.meta.filename), "doctor-tip-actionable-contract-"),
  );
  workspaces.push(root);
  const project = path.join(root, "project");
  const agentDirectory = path.join(root, "agent");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "source.ts"), "export const value = 1;\n", "utf8");
  await installExecutable(agentDirectory, "rg");
  await installExecutable(path.join(project, "node_modules"), "ast-grep", ".bin");
  await writeLinterConfig(project, "missing-eslint");

  const first = await runPi({
    agentDirectory,
    project,
    testName: "doctor-tip-actionable-first",
    extensions: [ideExtension],
  });
  const repeated = await runPi({
    agentDirectory,
    project,
    testName: "doctor-tip-actionable-repeated",
    extensions: [ideExtension],
  });
  await writeLinterConfig(project, "missing-oxlint");
  const changed = await runPi({
    agentDirectory,
    project,
    testName: "doctor-tip-actionable-changed",
    extensions: [ideExtension],
  });

  expect(first.tuiRenderedOutput).toContain("│ PI AGENT IDE · Project setup needs attention");
  expect(first.tuiRenderedOutput).toContain("│ • Configured linter custom cannot run");
  expect(first.tuiRenderedOutput).toContain("│ Run /pi-agent-ide-doctor");
  expect(first.providerRequests).toHaveLength(1);
  expect(JSON.stringify(first.providerRequests)).not.toContain("Configured linter custom");
  expect(repeated.tuiRenderedOutput).not.toContain("Project setup");
  expect(changed.tuiRenderedOutput).toContain("Project setup needs attention");
});

test("does not render the doctor tip when its core or provider extension is disabled", async () => {
  for (const disabledExtension of ["ide.tips", "ide.doctor"] as const) {
    const root = await mkdtemp(
      path.join(
        testArtifactsDir(import.meta.filename),
        `pi-agent-ide-doctor-disabled-${disabledExtension}-`,
      ),
    );
    workspaces.push(root);
    const enabledProject = path.join(root, "enabled-project");
    const disabledProject = path.join(root, "disabled-project");
    const enabledAgentDirectory = path.join(root, "enabled-agent");
    const disabledAgentDirectory = path.join(root, "disabled-agent");
    await mkdir(enabledProject, { recursive: true });
    await mkdir(disabledProject, { recursive: true });

    await writeFile(path.join(enabledProject, "source.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(disabledProject, "source.ts"), "export const value = 1;\n", "utf8");
    await writeLinterConfig(enabledProject, "missing-eslint");
    await writeLinterConfig(disabledProject, "missing-eslint");
    await installExecutable(enabledAgentDirectory, "rg");
    await installExecutable(disabledAgentDirectory, "rg");
    await installExecutable(path.join(enabledProject, "node_modules"), "ast-grep", ".bin");
    await installExecutable(path.join(disabledProject, "node_modules"), "ast-grep", ".bin");

    const enabled = await runPi({
      agentDirectory: enabledAgentDirectory,
      project: enabledProject,
      testName: `doctor-tip-${disabledExtension}-enabled`,
      extensions: [ideExtension],
    });
    expect(enabled.tuiRenderedOutput).toContain("│ PI AGENT IDE · Project setup");

    await mkdir(path.join(disabledAgentDirectory, "pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(disabledAgentDirectory, "pi-agent-ide", "extensions.json"),
      JSON.stringify({ disabled: [disabledExtension] }),
      "utf8",
    );
    const disabled = await runPi({
      agentDirectory: disabledAgentDirectory,
      project: disabledProject,
      testName: `doctor-tip-${disabledExtension}-disabled`,
      extensions: [ideExtension],
    });
    expect(disabled.tuiRenderedOutput).not.toContain("Project setup");
  }
});

async function installExecutable(root: string, name: string, directory = "bin"): Promise<void> {
  const file = path.join(root, directory, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
}

async function writeLinterConfig(project: string, command: string): Promise<void> {
  const file = path.join(project, ".pi", "pi-agent-ide", "linters.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      linters: {
        custom: {
          extensions: [".ts"],
          check: { command: [command, "{file}"] },
          diagnostics: { format: "gcc" },
        },
      },
    }),
    "utf8",
  );
}

async function runPi(options: {
  readonly agentDirectory: string;
  readonly project: string;
  readonly testName: string;
  readonly extensions?: readonly string[];
}) {
  const sharedRunner = process.env.PI_INTEGRATION_TEST_RUNNER;
  // Startup widgets require a real TUI session; bypass the shared runner's RPC lifecycle.
  delete process.env.PI_INTEGRATION_TEST_RUNNER;
  try {
    return await new PiIntegrationTest({
      testName: options.testName,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: options.project,
      extensions: [
        ...(options.extensions ?? [ideExtension, providerExtension]),
        path.resolve("tests/integration/fixtures/await-startup-tip.ts"),
      ],
      environment: { PI_CODING_AGENT_DIR: options.agentDirectory },
      isolateUserResources: false,
      rawMode: false,
      conversation: [assistantMessage([text("The startup tip contract run is complete.")])],
    }).run("Start the session and report when ready");
  } finally {
    if (sharedRunner === undefined) {
      delete process.env.PI_INTEGRATION_TEST_RUNNER;
    } else {
      process.env.PI_INTEGRATION_TEST_RUNNER = sharedRunner;
    }
  }
}
