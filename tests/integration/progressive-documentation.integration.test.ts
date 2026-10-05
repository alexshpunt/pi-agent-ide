import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { PiRun } from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
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
  expect(listDetails.ids).toEqual(
    expect.arrayContaining(["editing", "read-resources", "select-code"]),
  );
  expect(getToolResultMessage(result, "guide").details).toMatchObject({
    documentation: { kind: "document", id: "editing" },
  });
  expect(getToolExecution(result, "unknown").isError).toBe(true);
  expect(getToolResultMessage(result, "unknown").details).toMatchObject({
    documentation: { kind: "error", code: "UNKNOWN_DOCUMENTATION", id: "missing" },
  });
  const prompt = getProviderSystemPrompt(result);
  for (const id of ["editing", "read-resources", "search-code"]) expect(prompt).toContain(id);
});

test("attaches each relevant guide once and keeps guides independent", async () => {
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

  expectGuideAttachment(result, "read-first");
  expect(documentationDetails(result, "read-again")).toBeUndefined();
  expectGuideAttachment(result, "search-first");
  expect(documentationDetails(result, "search-again")).toBeUndefined();
});

test("rejects the retired Apply guide", async () => {
  const workspace = await createWorkspace();
  const result = await run(workspace, [
    { id: "retired", name: "read", arguments: { path: "docs:apply" } },
  ]);
  expect(getToolExecution(result, "retired").isError).toBe(true);
  expect(documentationDetails(result, "retired")).toMatchObject({
    kind: "error",
    code: "UNKNOWN_DOCUMENTATION",
  });
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
  const ids = ["parallel-a", "parallel-b"];
  const attached = ids.filter((id) => documentationDetails(result, id) !== undefined);
  expect(attached).toHaveLength(1);
  const first = attached[0];
  if (first === undefined) throw new Error("Missing guide attachment");
  expectGuideAttachment(result, first);
  for (const id of ids) expect(getToolExecution(result, id).isError).toBe(false);
});

test("adds the full guide to an error without changing failure status", async () => {
  const workspace = await createWorkspace();
  const result = await run(workspace, [
    { id: "missing-file", name: "read", arguments: { path: "missing.ts" } },
    { id: "after-error", name: "read", arguments: { path: "example.ts" } },
  ]);
  const message = getToolResultMessage(result, "missing-file");
  expect(message.isError).toBe(true);
  expect(documentationDetails(result, "missing-file")).toEqual({
    kind: "attachment",
    ids: ["read-resources"],
  });
  expect(
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  ).toContain("# Guide: read-resources");
  expect(documentationDetails(result, "after-error")).toBeUndefined();
  expect(getToolExecution(result, "after-error").isError).toBe(false);
});

test("a partial guide read does not consume the full document", async () => {
  const workspace = await createWorkspace();
  const result = await run(workspace, [
    { id: "partial-guide", name: "read", arguments: { path: "docs:read-resources", limit: 1 } },
    { id: "after-partial", name: "read", arguments: { path: "example.ts" } },
  ]);
  expectGuideAttachment(result, "after-partial");
});
test("listing guides does not consume them", async () => {
  const workspace = await createWorkspace();
  const result = await run(workspace, [
    { id: "listing", name: "read", arguments: { path: "docs:" } },
    { id: "after-listing", name: "read", arguments: { path: "example.ts" } },
  ]);
  expectGuideAttachment(result, "after-listing");
});

test("native Codemode returns guides without blocking or replaying mutations", async () => {
  const workspace = await createWorkspace();
  const result = await new PiIntegrationTest({
    testName: "progressive-docs-native-codemode",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: workspace,
    extensions: [extension, "builtin:codemode"],
    tools: ["read", "search", "insert", "codemode"],
    environment: { PI_AGENT_IDE_TEST_SKIP_GUIDE_PRELOAD: "1" },
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "nested-first",
            name: "codemode",
            arguments: {
              code: 'const read = await tools.read({path:"example.ts"}); if (typeof read !== "string" || !read.includes("marker")) throw new Error("Readable content lost"); if (read.includes("# Guide:")) throw new Error("Guide leaked into nested result"); text("success"); text(await tools.search({query:"marker",path:"example.ts"})); text(await tools.insert({path:"example.ts",anchor:"export const marker = 1;",text:"// changed"}));',
            },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          toolCall({
            id: "nested-again",
            name: "codemode",
            arguments: {
              code: 'text(await tools.read({path:"example.ts"}));',
            },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Use native Codemode tools once, then read again");
  const output = (id: string) =>
    getToolResultMessage(result, id)
      .content.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  expect(getToolExecution(result, "nested-first").isError).toBe(false);
  for (const id of ["read-resources", "search-code", "editing"])
    expect(output("nested-first")).toContain(`# Guide: ${id}`);
  expect(output("nested-again")).not.toContain("# Guide:");
  expect(output("nested-again")).toContain("changed");
  expect(await readFile(path.join(workspace, "example.ts"), "utf8")).toBe(
    "export const marker = 1;\n// changed",
  );
});
function expectGuideAttachment(result: Awaited<ReturnType<typeof run>>, id: string): void {
  const message = getToolResultMessage(result, id);
  expect(message.isError).toBe(false);
  expect(documentationDetails(result, id)).toMatchObject({ kind: "attachment" });
  const output = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(output).toContain("# Guide:");
  expect(output).not.toContain("Repeat the tool call");
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

test.each(["resume", "tree", "nested"] as const)(
  "restores guide state on %s without leaking from another branch",
  async (mode) => {
    const workspace = await createWorkspace();
    const first =
      mode === "nested"
        ? await run(
            workspace,
            [
              {
                id: "initial-script",
                name: "codemode",
                arguments: { code: 'await tools.read({path:"example.ts"});' },
              },
            ],
            ["read", "codemode"],
          )
        : await run(workspace, [
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
        IDE_RESTORE_TREE_ROOT: mode === "tree" ? "1" : "0",
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
    if (mode === "tree") expectGuideAttachment(restored, "restored-read");
    else expect(documentationDetails(restored, "restored-read")).toBeUndefined();
  },
);

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
    extensions: [extension, ...(tools.includes("codemode") ? ["builtin:codemode"] : [])],
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
