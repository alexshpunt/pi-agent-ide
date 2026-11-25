import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
import {
  initialApiState,
  mutationRequest,
  queryRequest,
  type ApiFixtureState,
  type ApiProbeDetails,
} from "./fixtures/api-probe.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const linear = path.join(root, "src/index.ts");
const probe = path.join(root, "tests/fixtures/api-probe.ts");
const artifacts = testArtifactsDir(import.meta.filename);
async function workspace() {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "linear-raw-api-"));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(
    path.join(cwd, ".pi/linear.json"),
    JSON.stringify({ axiPath: path.join(root, "tests/fixtures/api-axi.mjs") }),
  );
  await writeFile(path.join(cwd, "api-fixture.json"), JSON.stringify(initialApiState()));
  return cwd;
}
const load = async (cwd: string): Promise<ApiFixtureState> =>
  JSON.parse(await readFile(path.join(cwd, "api-fixture.json"), "utf8")) as ApiFixtureState;
function assertProbe(input: unknown, state: ApiFixtureState, headless: boolean) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("calls" in input) ||
    !Array.isArray(input.calls)
  )
    throw new Error("API probe did not return its call trace");
  const details = input as ApiProbeDetails;
  const sources = [
    details.queryResponse,
    details.mutationResponse,
    details.unknownResponse,
    details.partialResponse,
  ];
  for (const source of sources)
    expect(source).toMatch(/^linear:\/\/example\/api\/results\/[a-f0-9-]{36}$/u);
  expect(new Set(sources).size).toBe(4);
  expect(state.value).toBe("Partial mutation fixture");
  expect(state.reaction).toEqual({ id: mutationRequest.variables.input.id, emoji: "thumbsup" });
  const raw = state.requests.filter((request) => request.kind === "raw");
  expect(raw).toHaveLength(4);
  expect(raw[0].body).toEqual(queryRequest);
  expect(raw[1].body).toEqual(mutationRequest);
  expect(raw.filter((request) => request.body.operationName === "FixtureUnknown")).toHaveLength(1);
  expect(raw.filter((request) => request.body.operationName === "FixturePartial")).toHaveLength(1);
  expect(
    state.requests.every(
      (request) => request.authenticated && request.url === "https://api.linear.app/graphql",
    ),
  ).toBe(true);
  expect(state.requests.filter((request) => request.kind === "scope")).toHaveLength(4);
  const writes = details.calls.filter((call) => call.name === "write");
  const queried = writes.find((call) => String(call.args.content).includes("FixtureQuery"));
  const changed = writes.find((call) => String(call.args.content).includes("FixtureReaction"));
  const unknown = writes.find((call) => String(call.args.content).includes("FixtureUnknown"));
  const partial = writes.find((call) => String(call.args.content).includes("FixturePartial"));
  expect(queried).toMatchObject({
    isError: false,
    result: { details: { metadata: { semanticAction: { ok: true, effect: "not-applied" } } } },
  });
  expect(changed).toMatchObject({
    isError: false,
    result: { details: { metadata: { semanticAction: { ok: true, effect: "applied" } } } },
  });
  expect(unknown).toMatchObject({
    isError: true,
    result: { details: { metadata: { semanticAction: { ok: false, effect: "unknown" } } } },
  });
  expect(partial).toMatchObject({
    isError: true,
    result: {
      details: {
        metadata: { semanticAction: { ok: false, outcome: "partial", effect: "unknown" } },
      },
    },
  });
  expect(unknown?.result.details).toMatchObject({ effect: "unknown" });
  expect(partial?.result.details).toMatchObject({ effect: "unknown" });
  expect(state.typedMutations).toEqual([]);
  if (headless) {
    expect(details).toMatchObject({ hasUI: false, mode: "print" });
    const denied = writes.find((call) => String(call.args.path).endsWith("#merge"));
    expect(denied?.isError).toBe(true);
    expect(JSON.stringify(denied?.result)).toContain("LINEAR_CONFIRMATION_REQUIRED");
  }
  expect(JSON.stringify(details)).not.toContain("private-linear-raw-api-fixture-token");
}

// The scripted assistant invokes a test-only probe whose nested calls use the actual shared tools.
test.each(["ide-first", "linear-first", "standalone"] as const)(
  "real Pi retains and searches raw GraphQL responses (%s)",
  async (order) => {
    const ide = await currentIde();
    const cwd = await workspace();
    const standalone = order === "standalone";
    try {
      const operations: [string, string, Record<string, unknown>][] = [
        ...(standalone
          ? [
              ["discover", "tool_search", { query: "linear", limit: 20 }] as [
                string,
                string,
                Record<string, unknown>,
              ],
            ]
          : []),
        ["guides", "read", { path: "docs:" }],
        ["api-guide", "read", { path: "docs:linear-api" }],
        ["schema", "read", { path: "linear://example/api/graphql" }],
        ["probe", "verify_linear_raw_api", {}],
      ];
      const result = await new PiIntegrationTest({
        testName: "linear-raw-api-" + order,
        artifactsDir: artifacts,
        cwd,
        extensions: standalone
          ? ["builtin:tool-search", linear, probe]
          : order === "linear-first"
            ? [linear, probe, ide.extension]
            : [ide.extension, linear, probe],
        isolateUserResources: true,
        rawMode: false,
        tools: [
          ...(standalone ? ["tool_search"] : ["read", "write", "search"]),
          "verify_linear_raw_api",
        ],
        timeoutMs: 110000,
        providerMode: "user",
        model: "linear-raw-api-fixture/tui",
      }).run(
        "Verify raw GraphQL through ordinary resource tools against only the controlled fixture. Preserve exact response scopes and never replay unknown effects.",
      );
      await ide.record(result.artifacts.directory);
      const state = await load(cwd);
      await writeFile(
        path.join(result.artifacts.directory, "api-fixture-state.json"),
        JSON.stringify(state, null, 2),
      );
      for (const file of ["api-nested-tool-evidence.json", "api-axi-calls.jsonl"]) {
        const content = await readFile(path.join(cwd, file)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        );
        await writeFile(path.join(result.artifacts.directory, file), content);
      }
      for (const [id] of operations)
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      if (standalone) {
        expect(getToolExecutionDetails(getToolExecution(result, "guides"))).toMatchObject({
          source: "docs:",
        });
        expect(getToolExecutionDetails(getToolExecution(result, "api-guide"))).toMatchObject({
          source: "docs:linear-api",
        });
        expect(getToolResultText(result, "guides")).toContain("docs:linear-api");
      } else {
        const guides = getToolExecutionDetails(getToolExecution(result, "guides")) as {
          documentation?: { kind: string; ids?: string[] };
        };
        expect(guides.documentation?.kind).toBe("list");
        expect(guides.documentation?.ids).toContain("linear");
        expect(guides.documentation?.ids).toContain("linear-api");
        expect(getToolExecutionDetails(getToolExecution(result, "api-guide"))).toMatchObject({
          documentation: { kind: "document", id: "linear-api" },
        });
      }
      expect(getToolResultText(result, "schema")).toContain("operationName");
      assertProbe(getToolExecutionDetails(getToolExecution(result, "probe")), state, false);
      for (const id of ["query-result", "mutation-result", "unknown-result", "partial-result"]) {
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      }
      expect(getToolResultText(result, "query-result")).toContain("FIXTURE_17");
      expect(getToolResultText(result, "partial-result")).toContain("Partial mutation fixture");
      expect(result.tuiRenderedOutput).toContain("FIXTURE_17");
      expect(result.tuiRenderedOutput).not.toContain("private-linear-raw-api-fixture-token");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  140000,
);

// RPC has a UI binding. A print-mode SDK session establishes the genuine headless contract.
test("headless Pi allows raw mutations and denies the typed confirmation gate before dispatch", async () => {
  const ide = await currentIde();
  const cwd = await workspace();
  const directory = path.join(artifacts, "linear-raw-api-headless");
  await mkdir(directory, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "linear-raw-api-fixture",
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
    additionalExtensionPaths: [ide.extension, linear, probe],
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
      tools: ["read", "search", "write", "verify_linear_raw_api"],
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    const events: unknown[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    const model = session.modelRuntime.getModel("linear-raw-api-fixture", "headless");
    if (!model) throw new Error("Local Linear API fixture model was not registered");
    await session.setModel(model, { persist: false });
    await session.prompt(
      "Verify headless raw mutations and unchanged typed confirmation only against the controlled Linear fixture.",
    );
    const result = session.messages.find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === "headless-linear-api-probe",
    );
    if (!result || result.role !== "toolResult")
      throw new Error("Headless fixture did not execute its probe");
    await ide.record(directory);
    await writeFile(path.join(directory, "tool-result.json"), JSON.stringify(result, null, 2));
    await writeFile(path.join(directory, "session-events.json"), JSON.stringify(events, null, 2));
    await writeFile(
      path.join(directory, "api-nested-tool-evidence.json"),
      await readFile(path.join(cwd, "api-nested-tool-evidence.json")),
    );
    const state = await load(cwd);
    await writeFile(path.join(directory, "api-fixture-state.json"), JSON.stringify(state, null, 2));
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    assertProbe(result.details, state, true);
  } finally {
    dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
}, 140000);
