import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
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
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  PiRun,
  testArtifactsDir,
  text,
  toolCall,
  type PiIntegrationTestResult,
  getProviderSystemPrompt,
} from "./support/pi-runtime/native-pi-coding-agent-test.js";

const entry = path.resolve("src/pi-agent-ide.ts");
const fixture = path.resolve("tests/integration/fixtures/deferred-capabilities.ts");
const alpha = "fixture-capability-alpha";
const beta = "fixture-capability-beta";
const root = path.resolve(".tmp/deferred-capabilities");
function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
}
function read(result: PiIntegrationTestResult, id: string) {
  return JSON.parse(getToolResultText(result, id)) as {
    description: string;
    parameters: { properties: { path: { description: string } } };
    promptGuidelines: string[];
  };
}
async function run(
  name: string,
  mode: string,
  before: boolean,
  conversation: ReturnType<typeof assistantMessage>[],
  disabled: readonly string[] = [],
) {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  const agentDir = path.join(cwd, "agent");
  try {
    await mkdir(agentDir);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled, noPostProcessing: true }),
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultTools: ["+codemode", "+tool_search"],
        codemode: { mode, inlineBudget: 0 },
      }),
    );
    await writeFile(path.join(cwd, "example.txt"), "capability-resource-content\n");
    return await new PiIntegrationTest({
      testName: name,
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [
        ...(before ? [fixture, entry] : [entry, fixture]),
        "builtin:codemode",
        "builtin:tool-search",
      ],
      environment: { PI_CODING_AGENT_DIR: agentDir },
      conversation: [...conversation, assistantMessage([text("Done")])],
    }).run("Verify deferred capability schemas");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test.each([true, false])(
  "native discovery composes parameter schemas across extension registration order (%s)",
  async (before) => {
    const result = await run(`capabilities-order-${before}`, "on", before, [
      call("initial", "capability_snapshot"),
      call("unmatched", "tool_search", { query: "zxqv704839z", limit: 1 }),
      call("after-unmatched", "capability_snapshot"),
      call("discover-alpha", "tool_search", { query: "ide_capability_alpha", limit: 1 }),
      call("alpha", "capability_snapshot"),
      call("discover-beta", "tool_search", { query: "capability_beta", limit: 1 }),
      call("both", "capability_snapshot"),
      call("use-beta", "capability_beta"),
      call("repeated", "capability_snapshot"),
      call("resource", "read", { path: "example.txt" }),
    ]);
    expect(read(result, "initial").description).not.toContain(alpha);
    expect(read(result, "initial").description).not.toContain(beta);
    expect(read(result, "after-unmatched")).toEqual(read(result, "initial"));
    expect(read(result, "alpha").parameters.properties.path.description).toContain(alpha);
    expect(read(result, "alpha").parameters.properties.path.description).not.toContain(beta);
    for (const marker of [alpha, beta]) {
      expect(read(result, "both").description.split(marker)).toHaveLength(2);
      expect(
        read(result, "both").parameters.properties.path.description.split(marker),
      ).toHaveLength(2);
      expect(read(result, "both").promptGuidelines.filter((item) => item === marker)).toHaveLength(
        1,
      );
    }
    expect(read(result, "repeated")).toEqual(read(result, "both"));
    expect(getToolExecution(result, "resource").isError).toBe(false);
    expect(getToolResultText(result, "resource")).toContain("capability-resource-content");
    const initial = getCurrentTools(result.providerRequests[0]?.messages as Message[]).find(
      (tool) => tool.name === "read",
    );
    const activated = getCurrentTools(result.providerRequests.at(-1)?.messages as Message[]).find(
      (tool) => tool.name === "read",
    );
    expect(JSON.stringify(initial)).not.toContain(alpha);
    expect(JSON.stringify(activated)).toContain(alpha);
    expect(getProviderSystemPrompt(result)).not.toContain(alpha);
    expect(activated?.description).toContain(alpha);
  },
);

test("disabled debugger modules cannot activate contributed schemas", async () => {
  const result = await run(
    "capabilities-disabled",
    "only",
    false,
    [
      call("initial", "capability_snapshot"),
      call("discover", "tool_search", { query: "ide_debug debug", limit: 1 }),
      call("attempt", "codemode", {
        code: 'text(await searchTools("debug", { namespace: "ide_debug" }));',
      }),
      call("after", "capability_snapshot"),
    ],
    ["ide.debugger"],
  );
  expect(JSON.stringify(read(result, "initial"))).not.toContain("fixture-capability-debug");
  expect(JSON.stringify(read(result, "after"))).not.toContain("fixture-capability-debug");
});

test("terminal first use supports its shell Read and Delete through Codemode", async () => {
  const result = await run("capabilities-terminal-smoke", "on", false, [
    call("terminal", "codemode", {
      code: 'const terminal = await tools.bash({command: "printf deferred-terminal-smoke"}); text(terminal); const source = terminal.match(/shell:[\\w-]+/)?.[0]; if (!source) throw new Error("Missing terminal source"); text(await tools.read({path: source})); text(await tools.delete({path: source}));',
    }),
  ]);
  expect(getToolExecution(result, "terminal").isError).toBe(false);
  expect(getToolResultText(result, "terminal")).toContain("deferred-terminal-smoke");
});

// Resume the real recorded session; tree navigation must replace capability state, never union it.
test("capability schemas follow branch, reload, compaction and settings exclusions", async () => {
  const gamma = "fixture-capability-debug";
  const recorded = await run("capabilities-lifecycle", "on", false, [
    call("before", "capability_snapshot"),
    call("discover", "tool_search", { query: "ide_debug debug", limit: 1 }),
    call("after", "capability_snapshot"),
  ]);
  const transcript = requiredValue((await PiRun.open(recorded.artifacts.directory)).session);
  const cwd = await mkdtemp(path.join(root, "resume-"));
  const agentDir = path.join(cwd, "agent");
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session: AgentSession | undefined;
  try {
    await mkdir(agentDir);
    await writeFile(path.join(cwd, "recorded.jsonl"), transcript);
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
      additionalExtensionPaths: [entry, fixture],
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
    const current = () =>
      JSON.stringify(
        requiredValue(session)
          .getAllTools()
          .find((tool) => tool.name === "read"),
      );
    const discovered = requiredValue(manager.getLeafId());
    const before = requiredValue(
      manager
        .getBranch()
        .find(
          (item) =>
            item.type === "message" &&
            item.message.role === "toolResult" &&
            item.message.toolCallId === "before",
        ),
    );
    expect(current()).toContain(gamma);
    await session.navigateTree(before.id, { summarize: false });
    expect(current()).not.toContain(gamma);
    await session.navigateTree(discovered, { summarize: false });
    expect(current()).toContain(gamma);
    await session.reload();
    expect(current().split(gamma)).toHaveLength(4); // description, path description, guideline
    const kept = requiredValue(
      manager
        .getBranch()
        .find((item) => item.type === "message" && item.message.role === "assistant"),
    );
    manager.appendCompaction("fixture-summary", kept.id, 500);
    await session.reload();
    expect(current()).toContain(gamma);
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["-debug"] }),
    );
    await session.reload();
    expect(session.getAllTools().find((tool) => tool.name === "debug")?.exposure).toBe("hidden");
    expect(current()).not.toContain(gamma);
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["+debug"] }),
    );
    await session.reload();
    expect(current()).toContain(gamma);
    const forked = requiredValue(manager.createBranchedSession(requiredValue(manager.getLeafId())));
    expect(forked).not.toBe(path.join(cwd, "recorded.jsonl"));
    await session.reload();
    expect(current()).toContain(gamma);
  } finally {
    session?.dispose();
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each(["on", "only"])(
  "Codemode %s defers schemas until the first nested call",
  async (mode) => {
    const result = await run(`capabilities-codemode-${mode}`, mode, false, [
      call("initial", "capability_snapshot"),
      call("search", "codemode", {
        code: 'text(await searchTools("capability_beta")); text(await describeTool("capability_beta")); text(await describeNamespace("fixture_capabilities"));',
      }),
      call("after-search", "capability_snapshot"),
      call("use", "codemode", {
        code: 'text(await tools.capability_beta({})); text(await describeTool("read"));',
      }),
      call("after-use", "capability_snapshot"),
    ]);
    expect(read(result, "after-search")).toEqual(read(result, "initial"));
    expect(getToolExecution(result, "search").isError).toBe(false);
    expect(getToolExecution(result, "use").isError).toBe(false);
    expect(read(result, "after-use").parameters.properties.path.description).toContain(beta);
    expect(read(result, "after-use").description).not.toContain(alpha);
  },
);
