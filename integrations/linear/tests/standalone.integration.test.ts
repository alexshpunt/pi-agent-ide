import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
test("standalone approval blocks refusal and identity overrides before mutation", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/standalone-approval-"));
  try {
    const calls = [
      toolCall({
        id: "discover",
        name: "tool_search",
        arguments: { query: "linear write", limit: 8 },
      }),
      toolCall({
        id: "refused",
        name: "linear_write",
        arguments: { path: "linear://example/diff/refuse#merge", content: "{}" },
      }),
      toolCall({
        id: "allowed",
        name: "linear_write",
        arguments: {
          path: "linear://example/diff/allowed#merge",
          content: '{"note":"Allowed once"}',
        },
      }),
      toolCall({
        id: "invalid",
        name: "linear_write",
        arguments: {
          path: "linear://example/diff/invalid#merge",
          content: '{"urlOrId":"different-target"}',
        },
      }),
    ];
    const result = await new PiIntegrationTest({
      testName: "linear-standalone-approval",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: ["builtin:tool-search", path.join(root, "tests/fixtures/standalone-approval.ts")],
      tools: ["tool_search"],
      timeoutMs: 60_000,
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Finished.")]),
      ],
    }).run(
      "Exercise the standalone production permission gate with a controlled human answer and no remote backend.",
    );
    expect(getToolExecution(result, "refused").isError).toBe(true);
    expect(getToolResultText(result, "refused")).toContain("LINEAR_CONFIRMATION_REQUIRED");
    expect(getToolExecution(result, "allowed").isError, getToolResultText(result, "allowed")).toBe(
      false,
    );
    expect(getToolExecution(result, "invalid").isError).toBe(true);
    expect(getToolResultText(result, "invalid")).toContain("LINEAR_IDENTITY_OVERRIDE");
    const state = JSON.parse(
      await readFile(path.join(cwd, "standalone-approval.json"), "utf8"),
    ) as {
      mutations: unknown[];
      decisions: unknown[];
      waiting: { active: boolean; label?: string }[];
    };
    expect(state.mutations).toEqual([
      {
        workspace: "example",
        operation: "merge_diff",
        input: { urlOrId: "allowed", note: "Allowed once" },
      },
    ]);
    expect(state.decisions).toHaveLength(3);
    expect(state.waiting).toEqual(
      state.decisions.flatMap(() => [
        { active: true, label: "Waiting for operation approval" },
        { active: false },
      ]),
    );
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
const body = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
const issue = "linear://example/issue/ENG-12";

// Pattern: extensions example and loading.integration.test.ts, using the locked SDK.
// Contract: real Pi loads Linear without the IDE extension and preserves guarded mutations.
test("Linear works without loading the IDE extension", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/standalone-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "tests/fixtures/axi.mjs") }),
    );
    const calls: [string, string, Record<string, unknown>][] = [
      ["discover", "tool_search", { query: "linear read write insert", limit: 8 }],
      ["guide", "linear_read", { path: "docs:linear" }],
      ["body", "linear_read", { path: body }],
      ["save-status", "linear_write", { path: `${issue}#status`, content: "In Progress" }],
      ["labels", "linear_read", { path: `${issue}#labels` }],
      ["add-label", "linear_insert", { path: `${issue}#labels`, anchor: "end", text: "Feature" }],
      ["verify", "linear_read", { path: `${issue}#fields` }],
      [
        "create",
        "linear_write",
        {
          path: "linear://example/issue/new",
          content: JSON.stringify({ team: "ENG", title: "Created fixture" }),
        },
      ],
    ];
    const result = await new PiIntegrationTest({
      testName: "linear-standalone",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: ["builtin:tool-search", path.join(root, "src/index.ts")],
      tools: ["tool_search"],
      timeoutMs: 60_000,
      conversation: [
        ...calls.map(([id, name, args]) =>
          assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Finished.")]),
      ],
    }).run("Use standalone Linear tools only against the synthetic backend.");
    for (const [id] of calls)
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(getToolResultText(result, "guide")).toContain("Linear");
    expect(getToolResultText(result, "body")).toContain("Full document");
    expect(getToolResultText(result, "verify")).toContain("In Progress");
    expect(getToolResultText(result, "verify")).toContain("Feature");
    expect(getToolResultText(result, "create")).toContain("linear://example/issue/ENG-99");
    expect(getToolResultText(result, "create").match(/Read:/gu)).toHaveLength(1);
    expect(getToolResultText(result, "add-label").match(/Read:/gu)).toHaveLength(1);
    const state = JSON.parse(await readFile(path.join(cwd, "field-fixture.json"), "utf8")) as {
      description: unknown;
    };
    expect(state.description).toBe("Unchanged body");
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);

test.each([false, true])(
  "the loaded IDE owns Linear tools in either load order (providerFirst=%s)",
  async (providerFirst) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/standalone-ide-"));
    const { extension: ide } = await currentIde();
    const linear = path.join(root, "src/index.ts");
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "tests/fixtures/axi.mjs") }),
      );
      const result = await new PiIntegrationTest({
        testName: `linear-mode-${providerFirst ? "provider-first" : "ide-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: ["builtin:tool-search", ...(providerFirst ? [linear, ide] : [ide, linear])],
        tools: ["read", "tool_search"],
        timeoutMs: 60_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "discover",
                name: "tool_search",
                arguments: { query: "linear_read standalone", limit: 8 },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "body", name: "read", arguments: { path: body } })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Use the installed IDE SDK with the Linear extension against the fixture.");
      expect(getToolResultText(result, "discover")).not.toContain("linear_read");
      expect(getToolResultText(result, "body")).toContain("Full document");
      expect(getToolExecution(result, "body").isError).toBe(false);
      expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
      expect(result.tuiRenderedOutput).not.toContain("already handles");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);
