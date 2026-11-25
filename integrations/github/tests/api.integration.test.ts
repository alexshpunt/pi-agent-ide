import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
import { initialApiState, widgetSource, type ApiFixtureState } from "./fixtures/api-provider.ts";

import { githubPackageRoot as root } from "./fixtures/package-root.ts";
const fixture = path.join(root, "tests/fixtures/api-provider.ts");
const artifacts = testArtifactsDir(import.meta.filename);
const load = async (cwd: string): Promise<ApiFixtureState> =>
  JSON.parse(await readFile(path.join(cwd, "api-fixture.json"), "utf8")) as ApiFixtureState;
async function workspace() {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "github-open-api-"));
  await writeFile(path.join(cwd, "api-fixture.json"), JSON.stringify(initialApiState()));
  return cwd;
}
interface ProbeDetails {
  hasUI: boolean;
  mode: string;
  calls: {
    name: string;
    args: Record<string, unknown>;
    isError: boolean;
    result: AgentToolResult<unknown>;
  }[];
  restResponse: string;
  queryResponse: string;
  binary: string;
}
function assertProbe(details: ProbeDetails, state: ApiFixtureState, headless: boolean) {
  expect(details.restResponse).toMatch(/^github:\/\/api\/results\/[a-f0-9-]{36}$/u);
  expect(details.queryResponse).not.toBe(details.restResponse);
  expect(details.binary).not.toBe(details.queryResponse);
  expect(state).toMatchObject({ value: "Partial GraphQL effect", deleted: true });
  const mutations = state.requests.filter((request) => !["GET", "HEAD"].includes(request.method));
  expect(mutations).toEqual([
    expect.objectContaining({
      method: "PATCH",
      path: "/repos/example/project/widgets/17",
      body: { value: "REST changed" },
      authenticated: true,
    }),
    expect.objectContaining({
      method: "DELETE",
      path: "/repos/example/project/widgets/18",
      authenticated: true,
    }),
    expect.objectContaining({
      method: "POST",
      path: "/graphql",
      body: {
        query: "query View($id: ID!) { node(id: $id) { id } }",
        variables: { id: "WIDGET_17" },
        operationName: "View",
      },
      authenticated: true,
    }),
    expect.objectContaining({
      method: "POST",
      path: "/graphql",
      body: {
        query: "mutation Change($value: String!) { updateWidget(value: $value) { id } }",
        variables: { value: "GraphQL changed" },
        operationName: "Change",
      },
      authenticated: true,
    }),
    expect.objectContaining({
      method: "POST",
      path: "/repos/example/project/widgets/unknown",
      body: { value: "saved" },
      authenticated: true,
    }),
    expect.objectContaining({
      method: "POST",
      path: "/graphql",
      body: {
        query: "mutation Partial { change }",
        variables: { value: "Partial GraphQL effect" },
      },
      authenticated: true,
    }),
  ]);
  expect(
    state.requests.filter((request) => request.path === "/repos/example/project/widgets/unknown"),
  ).toHaveLength(1);
  expect(
    state.requests.filter((request) => request.host === "objects.githubusercontent.com"),
  ).toEqual([
    expect.objectContaining({ method: "GET", path: "/fixture/archive.zip", authenticated: false }),
  ]);
  expect(
    state.requests.every((request) =>
      ["api.github.com", "objects.githubusercontent.com"].includes(request.host),
    ),
  ).toBe(true);
  expect(
    state.requests.some(
      (request) => request.query.includes("access_token") || request.path.includes("/merge"),
    ),
  ).toBe(false);
  const unknown = details.calls.find(
    (call) => call.name === "write" && String(call.args.content).includes("/widgets/unknown"),
  );
  const partial = details.calls.find(
    (call) => call.name === "write" && String(call.args.content).includes("mutation Partial"),
  );
  expect(unknown).toMatchObject({ isError: true, result: { details: { effect: "unknown" } } });
  expect(partial).toMatchObject({ isError: true, result: { details: { effect: "unknown" } } });
  expect(
    details.calls.filter(
      (call) =>
        call.name === "read" && String(call.args.path).startsWith("raw:github://api/results/"),
    ),
  ).toHaveLength(1);
  if (headless) {
    expect(details).toMatchObject({ hasUI: false, mode: "print" });
    const typed = details.calls.find(
      (call) => call.args.path === "github://example/project/pulls/12/merge",
    );
    expect(typed?.isError).toBe(true);
    expect(JSON.stringify(typed?.result)).toContain("GH_APPROVAL_REQUIRED");
  }
  expect(JSON.stringify(details)).not.toContain("private-open-api-fixture-token");
}

// Pattern: extensions example plus the provider's genuine shared-tool nested probes.
// Contract: raw requests expose reusable response resources without widening Read/Search scopes.
test.each([false, true])(
  "real Pi reads unfamiliar API resources and raw Write responses (standalone=%s)",
  async (standalone) => {
    const ide = await currentIde();
    const cwd = await workspace();
    try {
      const operations: [string, string, Record<string, unknown>][] = [
        ["guides", "read", { path: "docs:" }],
        ["api-guide", "read", { path: "docs:github-api" }],
        ["rest-schema", "read", { path: "github://api/rest" }],
        ["graphql-schema", "read", { path: "github://api/graphql" }],
        ["unfamiliar", "read", { path: widgetSource }],
        ["api-probe", "verify_open_api", {}],
      ];
      const result = await new PiIntegrationTest({
        testName: "github-open-api-resources-" + (standalone ? "standalone" : "ide"),
        artifactsDir: artifacts,
        cwd,
        extensions: standalone ? [fixture] : [ide.extension, fixture],
        isolateUserResources: true,
        rawMode: false,
        tools: [
          ...["read", "search", "write"].map((name) => (standalone ? "github_" + name : name)),
          "verify_open_api",
        ],
        timeoutMs: 90_000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage(
              [
                toolCall({
                  id,
                  name: standalone && name !== "verify_open_api" ? "github_" + name : name,
                  arguments: args,
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          assistantMessage([text("Finished the open API fixture.")]),
        ],
      }).run(
        "Read GitHub API resources and verify arbitrary requests only against the controlled fixture. Keep selections exact and never replay an unknown effect.",
      );
      await ide.record(result.artifacts.directory);
      const state = await load(cwd);
      await writeFile(
        path.join(result.artifacts.directory, "http-fixture-state.json"),
        JSON.stringify(state, null, 2),
      );
      for (const [id] of operations)
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      const guideIndex = getToolExecutionDetails(getToolExecution(result, "guides")) as {
        documentation?: { kind?: string; ids?: string[] };
      };
      expect(guideIndex.documentation?.kind).toBe("list");
      expect(guideIndex.documentation?.ids).toEqual(
        expect.arrayContaining(["github", "github-api"]),
      );
      expect(getToolExecutionDetails(getToolExecution(result, "api-guide"))).toMatchObject({
        documentation: { kind: "document", id: "github-api" },
      });
      expect(getToolResultText(result, "unfamiliar")).toContain("Original API value");
      const details = getToolExecutionDetails(
        getToolExecution(result, "api-probe"),
      ) as ProbeDetails;
      assertProbe(details, state, false);
      for (const [id] of operations)
        expect(getToolResultText(result, id)).not.toContain("private-open-api-fixture-token");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);

// RPC has a UI binding. The SDK print session proves real headless YOLO and a preserved typed gate.
test("headless Pi allows arbitrary App API mutations while typed merge stays denied with zero HTTP", async () => {
  const ide = await currentIde();
  const cwd = await workspace();
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({
      flags: { "pi-agent-ide-yolo": false, "pi-agent-github-yolo": false },
    }),
  );
  const directory = path.join(artifacts, "github-open-api-headless");
  await mkdir(directory, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "open-api-fixture",
    defaultModel: "headless",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [ide.extension, fixture],
  });
  let dispose: (() => void) | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd,
      agentDir: path.join(cwd, "agent"),
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["read", "search", "write", "verify_open_api"],
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    const events: unknown[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    const model = session.modelRuntime.getModel("open-api-fixture", "headless");
    if (!model) throw new Error("The local open API model was not registered");
    await session.setModel(model, { persist: false });
    expect(session.model?.provider).toBe("open-api-fixture");
    await session.prompt(
      "Exercise headless raw App API writes and the typed merge gate against the controlled HTTP fixture.",
    );
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "headless-api-probe",
    );
    if (!result || result.role !== "toolResult")
      throw new Error("Headless Pi did not execute its API probe");
    await ide.record(directory);
    await writeFile(path.join(directory, "tool-result.json"), JSON.stringify(result, null, 2));
    await writeFile(
      path.join(directory, "read-selection-evidence.json"),
      await readFile(path.join(cwd, "read-selection-evidence.json")),
    );
    await writeFile(
      path.join(directory, "nested-tool-evidence.json"),
      await readFile(path.join(cwd, "nested-tool-evidence.json")),
    );
    await writeFile(path.join(directory, "session-events.json"), JSON.stringify(events, null, 2));
    const state = await load(cwd);
    await writeFile(
      path.join(directory, "http-fixture-state.json"),
      JSON.stringify(state, null, 2),
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const details: unknown = result.details;
    assertProbe(details as ProbeDetails, state, true);
  } finally {
    dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
