import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requiredValue } from "pi-agent-invariant";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  PiRun,
  testArtifactsDir,
  text,
  toolCall,
  type PiIntegrationTestResult,
} from "./support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

const entry = path.resolve("src/pi-agent-ide.ts");
const probe = path.resolve("tests/integration/fixtures/ide-exposure-probe.ts");
const root = path.resolve(".tmp/ide-exposure");

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
}
function snapshot(result: PiIntegrationTestResult, id = "snapshot") {
  return JSON.parse(getToolResultText(result, id)) as {
    active: string[];
    callable: string[];
    tools: {
      name: string;
      exposure: string;
      namespace?: { name: string };
      annotations?: { readOnlyHint?: boolean };
    }[];
    nested?: { isError?: boolean; content?: unknown };
  };
}
function declarations(result: PiIntegrationTestResult, index = 0) {
  return getCurrentTools(result.providerRequests[index]?.messages as Message[]);
}

async function runCase(
  name: string,
  conversation: ReturnType<typeof assistantMessage>[],
  settings: Record<string, unknown> = {},
  disabled: string[] = [],
  selection?: string,
  gitChanges = false,
) {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  const agentDir = path.join(cwd, "agent");
  try {
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    await writeFile(path.join(cwd, "example.txt"), "native-exposure-marker\n");
    if (gitChanges) {
      execFileSync("git", ["init", "--quiet", cwd]);
      execFileSync("git", ["-C", cwd, "add", "example.txt"]);
      execFileSync("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Fixture",
      ]);
      await writeFile(path.join(cwd, "example.txt"), "native-exposure-marker\nadded change\n");
    }
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled, noPostProcessing: true }),
    );
    return await new PiIntegrationTest({
      testName: name,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [entry, probe, "builtin:codemode", "builtin:tool-search"],
      piCommand:
        selection === undefined
          ? undefined
          : path.resolve("tests/integration/support/pi-runtime/selected-host.sh"),
      environment: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_IDE_TEST_SELECTION: selection,
        PI_AGENT_IDE_TEST_HOST_COMMAND: process.env.PI_COMMAND ?? "pi",
      },
      conversation: [...conversation, assistantMessage([text("Done")])],
    }).run("Verify native IDE availability");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test.each(["on", "only"])(
  "native IDE exposure with Codemode %s and a small budget",
  async (mode) => {
    const result = await runCase(
      `ide-exposure-${mode}`,
      [
        call("snapshot", "ide_exposure_probe", {
          target: "apply",
          args: { source: "removed" },
        }),
        call("apply", "apply", { source: "removed" }),
        call("script", "codemode", {
          code: 'text(await tools.read({path: "example.txt"})); text(await searchTools("stage", {namespace: "ide_git"})); text(await describeNamespace("ide_edit"));',
        }),
        call("discover", "tool_search", { query: "ide_debug debug", limit: 1 }),
        mode === "on"
          ? call("debug", "debug", { adapter: "debugpy", program: "example.txt" })
          : call("debug", "codemode", {
              code: 'text(await tools.debug({adapter: "debugpy", program: "example.txt"}));',
            }),
        call("after", "ide_exposure_probe"),
      ],
      { defaultTools: ["+codemode"], codemode: { mode, inlineBudget: 0 } },
    );
    const state = snapshot(result);
    expect(state.active).not.toContain("debug");
    expect(state.active).not.toContain("stage");
    expect(state.active).toContain("tool_search");
    expect(state.callable).not.toContain("apply");
    expect(state.callable).toEqual(
      expect.arrayContaining(["read", "diff", "debug", "stage", "unstage"]),
    );
    expect(state.nested?.isError).toBe(true);
    for (const [name, exposure, namespace] of [
      ["read", "direct", "ide_read"],
      ["diff", "direct", "ide_read"],
      ["search", "direct", "ide_search"],
      ["write", "direct", "ide_edit"],
      ["bash", "direct", "ide_terminal"],
      ["stage", "deferred", "ide_git"],
      ["unstage", "deferred", "ide_git"],
      ["debug", "deferred", "ide_debug"],
    ])
      expect(state.tools.find((tool) => tool.name === name)).toMatchObject({
        exposure,
        namespace: { name: namespace },
      });
    expect(state.tools.find((tool) => tool.name === "read")?.annotations?.readOnlyHint).toBe(false);
    expect(declarations(result).map((tool) => tool.name)).not.toContain("apply");
    expect(state.tools.map((tool) => tool.name)).not.toContain("apply");
    expect(declarations(result).map((tool) => tool.name)).not.toContain("debug");
    expect(
      declarations(result)
        .map((tool) => tool.name)
        .includes("read"),
    ).toBe(mode === "on");
    expect(getToolExecution(result, "apply").isError).toBe(true);
    expect(getToolResultText(result, "apply")).toContain("Tool apply not found");
    expect(getToolResultText(result, "script")).toContain("native-exposure-marker");
    expect(getToolResultText(result, "script")).not.toContain("third-party-stage-marker");
    expect(getToolResultText(result, "discover")).toContain("debug");
    expect(getToolExecution(result, "debug").isError).toBe(false);
    expect(snapshot(result, "after").active).toContain("debug");
  },
);

test("deferred Git tools execute through native Codemode after namespace discovery", async () => {
  const result = await runCase(
    "ide-git-execution",
    [
      call("discover", "tool_search", { query: "ide_git stage unstage", limit: 2 }),
      call("git", "codemode", {
        code: 'const first = await tools.read({path: "example.txt", views: ["changes"]}); const change = first.match(/CHANGE#[A-F0-9]+/)?.[0]; text(await tools.stage({file: "example.txt", change})); const staged = await tools.read({path: "example.txt", views: ["changes"]}); const next = staged.match(/CHANGE#[A-F0-9]+/)?.[0]; text(await tools.unstage({file: "example.txt", change: next}));',
      }),
    ],
    { defaultTools: ["+codemode"] },
    [],
    undefined,
    true,
  );
  expect(getToolResultText(result, "discover")).not.toContain("stage_note");
  expect(getToolExecution(result, "git").isError).toBe(false);
  expect(getToolResultText(result, "git")).toContain("Staged");
  expect(getToolResultText(result, "git")).toContain("Unstaged");
});

test.each(["settings", "modules"])(
  "disabled IDE tools have no nested or discovery path (%s)",
  async (source) => {
    const result = await runCase(
      `ide-disabled-${source}`,
      [
        call("snapshot", "ide_exposure_probe", {
          target: "debug",
          args: { adapter: "debugpy", program: "example.txt" },
        }),
        call("script", "codemode", {
          code: 'text(await searchTools("debug", {namespace: "ide_debug"})); text(await searchTools("stage", {namespace: "ide_git"})); text(ALL_TOOLS.map(t => t.name));',
        }),
      ],
      {
        defaultTools: [
          "+codemode",
          ...(source === "settings" ? ["-debug", "-stage", "-unstage"] : []),
        ],
      },
      source === "modules" ? ["ide.debugger", "ide.changes"] : [],
    );
    const state = snapshot(result);
    expect(state.callable).not.toContain("debug");
    expect(state.callable).not.toContain("stage");
    expect(state.callable).not.toContain("unstage");
    expect(state.nested?.isError).toBe(true);
    const prompt = getProviderSystemPrompt(result);
    expect(prompt).not.toContain("Use tool_search to find debug");
    expect(prompt).not.toContain("Use tool_search to find stage");
    expect(getToolResultText(result, "script")).not.toMatch(/"(?:debug|stage|unstage)"/);
  },
);

test.each(["exclude", "allow"])(
  "native CLI selection removes every callable path (%s)",
  async (selection) => {
    const result = await runCase(
      `ide-cli-${selection}`,
      [
        call("snapshot", "ide_exposure_probe", {
          target: "debug",
          args: { adapter: "debugpy", program: "example.txt" },
        }),
        call("script", "codemode", {
          code: 'text(await searchTools("debug", {namespace: "ide_debug"})); text(await searchTools("stage", {namespace: "ide_git"}));',
        }),
      ],
      { defaultTools: ["+codemode", "+debug", "+stage", "+unstage"] },
      [],
      selection,
    );
    const state = snapshot(result);
    expect(state.tools.map((tool) => tool.name)).not.toContain("debug");
    expect(state.tools.map((tool) => tool.name)).not.toContain("stage");
    expect(state.nested?.isError).toBe(true);
    expect(getToolResultText(result, "script")).not.toMatch(/"(?:debug|stage|unstage)"/);
    expect(getProviderSystemPrompt(result)).not.toContain("<ide_discovery>");
  },
);

test("no-builtin-tools retains IDE tools and no-tools denies all calls", async () => {
  const extensions = await runCase(
    "ide-no-builtins",
    [call("snapshot", "ide_exposure_probe")],
    {},
    [],
    "no-builtins",
  );
  expect(snapshot(extensions).callable).toEqual(expect.arrayContaining(["read", "diff", "debug"]));
  const disabled = await runCase(
    "ide-no-tools",
    [call("snapshot", "ide_exposure_probe")],
    {},
    [],
    "no-tools",
  );
  expect(declarations(disabled)).toEqual([]);
  expect(getToolExecution(disabled, "snapshot").isError).toBe(true);
});

test("defaultTools + activates a deferred tool but later deactivation is respected", async () => {
  const result = await runCase(
    "ide-explicit-activation",
    [
      call("snapshot", "ide_exposure_probe", { deactivate: "debug" }),
      call("after", "ide_exposure_probe"),
    ],
    { defaultTools: ["+debug"] },
  );
  expect(declarations(result).map((tool) => tool.name)).toContain("debug");
  expect(snapshot(result, "after").active).not.toContain("debug");
  expect(snapshot(result, "after").callable).toContain("debug");
});

test("discovered activation follows the resumed branch and exclusions survive reload", async () => {
  const recorded = await runCase("ide-lifecycle-recording", [
    call("before", "ide_exposure_probe"),
    call("discover", "tool_search", { query: "ide_debug debug", limit: 1 }),
    call("snapshot", "ide_exposure_probe"),
  ]);
  const persisted = await PiRun.open(recorded.artifacts.directory);
  expect(persisted.session).toBeDefined();
  const cwd = await mkdtemp(path.join(root, "lifecycle-"));
  const agentDir = path.join(cwd, "agent");
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session: AgentSession | undefined;
  try {
    await mkdir(agentDir);
    await writeFile(path.join(cwd, "recorded.jsonl"), requiredValue(persisted.session));
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const manager = SessionManager.open(path.join(cwd, "recorded.jsonl"), cwd, cwd);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      additionalExtensionPaths: [entry],
      extensionFactories: [createCodemodeExtension(), createToolSearchExtension()],
    });
    await loader.reload();
    session = (
      await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: manager,
      })
    ).session;
    await session.bindExtensions({
      onError: (error) => {
        throw new Error(error.error);
      },
    });
    const discoveredLeaf = requiredValue(manager.getLeafId());
    await session.navigateTree(discoveredLeaf, { summarize: false });
    expect(session.getActiveToolNames()).toContain("debug");
    const beforeDiscovery = requiredValue(
      manager
        .getBranch()
        .find(
          (item) =>
            item.type === "message" &&
            item.message.role === "toolResult" &&
            item.message.toolCallId === "before",
        ),
    );
    await session.navigateTree(beforeDiscovery.id, { summarize: false });
    expect(session.getActiveToolNames()).not.toContain("debug");
    expect(session.getCallableToolNames()).toContain("debug");
    await session.navigateTree(discoveredLeaf, { summarize: false });
    expect(session.getActiveToolNames()).toContain("debug");
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["-debug", "-stage", "-unstage"] }),
    );
    await session.reload();
    expect(session.getCallableToolNames()).not.toContain("debug");
    expect(session.getActiveToolNames()).not.toContain("debug");
    expect(session.getAllTools().find((tool) => tool.name === "debug")?.exposure).toBe("hidden");
    await session.navigateTree(discoveredLeaf, { summarize: false });
    expect(session.getActiveToolNames()).not.toContain("debug");
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["+debug"] }),
    );
    await session.reload();
    expect(session.getActiveToolNames()).toContain("debug");
    expect(session.getAllTools().find((tool) => tool.name === "debug")?.namespace?.name).toBe(
      "ide_debug",
    );
  } finally {
    session?.dispose();
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
