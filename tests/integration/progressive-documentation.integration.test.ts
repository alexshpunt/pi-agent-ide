import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, afterEach, expect, test } from "vitest";
import { PiRun } from "pi-coding-agent-test/base";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const extension = process.env.PI_AGENT_IDE_TEST_EXTENSION ?? path.resolve("src/pi-agent-ide.ts");
const workspaces: string[] = [];
const restoreRuntime = forceStandaloneIntegrationFile();
afterAll(restoreRuntime);

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("lists, reads, and rejects documentation resources through real Pi", async () => {
  const workspace = await createWorkspace();
  const result = await run(workspace, [
    { id: "list", name: "read", arguments: { path: "docs:" } },
    { id: "guide", name: "read", arguments: { path: "docs:editing" } },
    { id: "unknown", name: "read", arguments: { path: "docs:missing" } },
  ]);

  const listDetails = documentationDetails(result, "list") as {
    readonly kind: string;
    readonly ids: readonly string[];
  };
  expect(listDetails.kind).toBe("list");
  expect(listDetails.ids).toEqual(expect.arrayContaining(["apply", "editing", "read-resources"]));
  expect(getToolResultMessage(result, "guide").details).toMatchObject({
    documentation: { kind: "document", id: "editing" },
  });
  expect(getToolExecution(result, "unknown").isError).toBe(true);
  expect(getToolResultMessage(result, "unknown").details).toMatchObject({
    documentation: { kind: "error", code: "UNKNOWN_DOCUMENTATION", id: "missing" },
  });
  const prompt = getProviderSystemPrompt(result);
  for (const id of ["apply", "editing", "read-resources", "search-code"])
    expect(prompt).toContain(id);
});

test("gates each relevant tool once and keeps guides independent", async () => {
  const workspace = await createWorkspace();
  const result = await run(
    workspace,
    [
      { id: "read-first", name: "read", arguments: { path: "example.ts" } },
      { id: "read-again", name: "read", arguments: { path: "example.ts" } },
      { id: "search-first", name: "search", arguments: { query: "marker", path: "example.ts" } },
      { id: "search-again", name: "search", arguments: { query: "marker", path: "example.ts" } },
    ],
    ["read", "search"],
  );

  expectGuideGate(result, "read-first");
  expect(documentationDetails(result, "read-again")).toBeUndefined();
  expectGuideGate(result, "search-first");
  expect(documentationDetails(result, "search-again")).toBeUndefined();
});

test("gates Apply once before executing it", async () => {
  const workspace = await createWorkspace();
  const result = await run(
    workspace,
    [
      {
        id: "apply-first",
        name: "apply",
        arguments: { source: 'const file = open("example.ts"); file.find("marker");' },
      },
      {
        id: "apply-again",
        name: "apply",
        arguments: { source: 'const file = open("example.ts"); file.find("marker");' },
      },
    ],
    ["apply"],
  );

  expectGuideGate(result, "apply-first");
  expect(documentationDetails(result, "apply-again")).toBeUndefined();
  expect(getToolExecution(result, "apply-first").isError).toBe(true);
  expect(getToolExecution(result, "apply-again").isError).toBe(false);
});

test("an explicit guide read allows the first matching tool call", async () => {
  const workspace = await createWorkspace();
  const result = await run(
    workspace,
    [
      { id: "guide", name: "read", arguments: { path: "docs:search-code" } },
      { id: "search", name: "search", arguments: { query: "marker", path: "example.ts" } },
    ],
    ["read", "search"],
  );

  expect(documentationDetails(result, "guide")).toEqual({ kind: "document", id: "search-code" });
  expect(documentationDetails(result, "search")).toBeUndefined();
  expect(getToolExecution(result, "search").isError).toBe(false);
});

test("claims a guide once across parallel tool calls", async () => {
  const workspace = await createWorkspace();
  const result = await new PiIntegrationTest({
    testName: "progressive-docs-parallel-claim",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: workspace,
    extensions: [extension],
    tools: ["search"],
    environment: {
      PI_AGENT_IDE_TEST_SKIP_GUIDE_PRELOAD: "1",
      PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "0",
    },
    conversation: [
      assistantMessage(
        [
          toolCall({ id: "parallel-a", name: "search", arguments: { query: "marker" } }),
          toolCall({ id: "parallel-b", name: "search", arguments: { query: "marker" } }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Run two searches");
  expectGuideGate(result, "parallel-a");
});

function expectGuideGate(result: Awaited<ReturnType<typeof run>>, id: string): void {
  const message = getToolResultMessage(result, id);
  expect(message.isError).toBe(true);
  const textLength = message.content.reduce(
    (total, part) => total + (part.type === "text" ? part.text.length : 0),
    0,
  );
  expect(textLength).toBeGreaterThan(0);
  expect(textLength).toBeLessThan(200);
}

function documentationDetails(result: Awaited<ReturnType<typeof run>>, id: string): unknown {
  const details = getToolResultMessage(result, id).details as
    | { readonly documentation?: unknown }
    | undefined;
  return details?.documentation;
}

test("filters documents with their disabled owner modules", async () => {
  const workspace = await createWorkspace();
  await mkdir(path.join(workspace, ".pi", "pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(workspace, ".pi", "pi-agent-ide", "extensions.json"),
    JSON.stringify({ disabled: ["search.core"] }),
  );
  const result = await run(workspace, [
    { id: "list-filtered", name: "read", arguments: { path: "docs:" } },
  ]);
  const details = documentationDetails(result, "list-filtered") as { readonly ids: string[] };
  expect(details.ids).toContain("read-resources");
  expect(details.ids).not.toContain("search-code");
});

test("restores attachment claims from persisted tool results", async () => {
  const workspace = await createWorkspace();
  const first = await run(workspace, [
    { id: "initial-read", name: "read", arguments: { path: "example.ts" } },
  ]);
  const captured = await PiRun.open(first.artifacts.run);
  if (captured.session === undefined) throw new Error("Missing persisted session");
  const session = path.join(workspace, "progressive-docs-session.jsonl");
  await writeFile(session, captured.session);
  const restored = await new PiIntegrationTest({
    testName: "progressive-docs-restored",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: workspace,
    extensions: [extension, path.resolve("tests/integration/fixtures/restore-tool-history.ts")],
    environment: {
      IDE_RESTORE_SESSION: session,
      PI_AGENT_IDE_TEST_SKIP_GUIDE_PRELOAD: "1",
      PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "0",
    },
    tools: ["read"],
    conversation: [
      assistantMessage(
        [toolCall({ id: "restored-read", name: "read", arguments: { path: "example.ts" } })],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("/restore-tool-history");
  expect(documentationDetails(restored, "restored-read")).toBeUndefined();
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "progressive-docs-"));
  workspaces.push(workspace);
  await writeFile(path.join(workspace, "example.ts"), "export const marker = 1;\n");
  return workspace;
}

async function run(
  cwd: string,
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[],
  tools: readonly string[] = ["read"],
) {
  return new PiIntegrationTest({
    testName: calls[0]?.id ?? "progressive-docs",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [extension],
    tools,
    environment: {
      PI_AGENT_IDE_TEST_SKIP_GUIDE_PRELOAD: "1",
      PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "0",
    },
    conversation: [
      ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
      assistantMessage([text("Done")]),
    ],
  }).run("Exercise progressive documentation");
}
