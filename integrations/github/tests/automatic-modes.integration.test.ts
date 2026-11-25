import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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
import { githubPackageRoot } from "./fixtures/package-root.ts";
import { currentIde } from "./fixtures/current-ide.ts";

interface GithubFixtureJournal {
  issues: Record<string, { body: string }>;
  requests: { path: string; method: string }[];
}

const root = githubPackageRoot;
const fixture = path.join(root, "tests/fixtures/automatic-provider.ts");
const issue = "github://example/project/issues/12";
const body = issue + "#body";

async function workspace() {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/automatic-github-"));
  await writeFile(path.join(cwd, "local.txt"), "Local sentinel\n");
  await writeFile(
    path.join(cwd, "github-fixture.json"),
    JSON.stringify({
      issues: {
        "12": {
          number: 12,
          id: 12,
          title: "Mode fixture",
          body: "First line\nLast line\n",
          state: "open",
          updated_at: "original-revision",
          html_url: "https://github.com/example/project/issues/12",
          repository_url: "https://api.github.com/repos/example/project",
          labels: [],
          assignees: [],
          milestone: null,
        },
      },
      comments: [],
      requests: [],
      sequence: 0,
    }),
  );
  return cwd;
}

// Pattern: existing HTTP-boundary provider case and the public standalone SDK example.
// Contract: only the chosen surface is discoverable after every extension factory has loaded.
test.each(["standalone", "ide-first", "github-first"] as const)(
  "GitHub automatically chooses one visible resource surface (%s)",
  async (mode) => {
    const ide = await currentIde();
    const cwd = await workspace();
    try {
      const name = mode === "standalone" ? "github_read" : "read";
      const extensions =
        mode === "standalone"
          ? [fixture]
          : mode === "ide-first"
            ? [ide.extension, fixture]
            : [fixture, ide.extension];
      const result = await new PiIntegrationTest({
        testName: "automatic-github-" + mode,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: [...extensions, "builtin:tool-search", "builtin:codemode"],
        tools: [
          "tool_search",
          "codemode",
          "mode_probe",
          ...(mode === "standalone" ? [] : ["read"]),
        ],
        timeoutMs: 60_000,
        conversation: [
          assistantMessage([toolCall({ id: "mode", name: "mode_probe", arguments: {} })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [
              toolCall({
                id: "discover",
                name: "tool_search",
                arguments: { query: "github", limit: 30 },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "catalog",
                name: "codemode",
                arguments: {
                  code:
                    mode === "standalone"
                      ? 'text(await describeTool("github_read"));'
                      : 'if (await describeTool("github_read") !== undefined || ALL_TOOLS.some(tool => tool.name === "github_read")) throw new Error("Hidden GitHub tool stayed discoverable"); text("No standalone GitHub tool");',
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "read", name, arguments: { path: body } })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [
              toolCall({
                id: "denied",
                name,
                arguments: { path: "github://example/project/issues/403#body" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Use the GitHub resource surface available in this session.");
      for (const id of ["mode", "discover", "catalog", "read"])
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      const status = JSON.parse(getToolResultText(result, "mode")) as {
        visible: string[];
        active: string[];
      };
      if (mode === "standalone") {
        expect(status.visible).toEqual([
          "github_copy",
          "github_delete",
          "github_diff",
          "github_insert",
          "github_move",
          "github_read",
          "github_replace",
          "github_search",
          "github_write",
        ]);
        expect(getToolResultText(result, "discover")).toContain("github_read");
      } else {
        expect(status).toEqual({ visible: [], active: [] });
        expect(getToolResultText(result, "discover")).not.toContain("github_read");
      }
      expect(getToolResultText(result, "read")).toContain("First line\nLast line");
      expect(getToolExecution(result, "denied").isError).toBe(true);
      expect(getToolResultText(result, "denied")).toContain("GH_FORBIDDEN");
      expect(getToolResultText(result, "denied")).not.toContain("private-fixture-token");
      const state = JSON.parse(
        await readFile(path.join(cwd, "github-fixture.json"), "utf8"),
      ) as GithubFixtureJournal;
      const deniedRequests = state.requests.filter((request: { path: string }) =>
        request.path.endsWith("/issues/403"),
      );
      expect(deniedRequests.length).toBeGreaterThan(0);
      expect(deniedRequests.every((request: { method: string }) => request.method === "GET")).toBe(
        true,
      );
      expect(state.requests.some((request: { method: string }) => request.method !== "GET")).toBe(
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);

test("standalone GitHub keeps direct and Codemode edits bounded without local fallbacks", async () => {
  const cwd = await workspace();
  try {
    const operations: { id: string; name: string; arguments: Record<string, unknown> }[] = [
      { id: "discover", name: "tool_search", arguments: { query: "github", limit: 30 } },
      { id: "guide", name: "github_read", arguments: { path: "docs:github" } },
      { id: "editing-guide", name: "github_read", arguments: { path: "docs:editing" } },
      {
        id: "native",
        name: "github_read",
        arguments: { path: "https://github.com/example/project/issues/12#body" },
      },
      {
        id: "script",
        name: "codemode",
        arguments: {
          code: [
            `const first = await tools.github_read({path: "${body}", offset: 1, limit: 1});`,
            "const same = await tools.github_read({path: first, limit: 100});",
            'const absent = await tools.github_search({path: same, query: "Last line"});',
            'if (!absent || !absent.complete || absent.matches.length !== 0) throw Error("Search escaped the selection");',
            'const selected = await tools.github_search({path: same, query: "First line"});',
            'if (!selected || selected.matches.length !== 1) throw Error("Expected one scoped match");',
            'await tools.github_replace({path: selected, text: "Scoped"});',
          ].join("\n"),
        },
      },
      {
        id: "direct",
        name: "github_replace",
        arguments: { path: body, at: "Scoped", text: "Direct" },
      },
      { id: "verify", name: "github_read", arguments: { path: body } },
      { id: "local", name: "github_read", arguments: { path: "local.txt" } },
      {
        id: "raw-local",
        name: "github_read",
        arguments: { path: "raw:" + path.join(cwd, "local.txt") },
      },
      {
        id: "local-write",
        name: "github_write",
        arguments: { path: "local.txt", content: "wrong" },
      },
      { id: "local-copy", name: "github_copy", arguments: { path: body, target: "local.txt" } },
      {
        id: "unknown",
        name: "github_write",
        arguments: {
          path: "github://example/project/issues/new",
          content: JSON.stringify({ title: "simulate-unknown", body: "Applied once" }),
        },
      },
    ];
    operations.push({ id: "scope", name: "verify_github_scope", arguments: {} });
    const result = await new PiIntegrationTest({
      testName: "automatic-github-standalone-bounds",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [fixture, "builtin:codemode", "builtin:tool-search"],
      tools: ["tool_search", "codemode", "verify_github_scope"],
      timeoutMs: 60_000,
      conversation: [
        ...operations.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run(
      "Keep selected GitHub text bounded, refuse local sources, and do not replay an unknown effect.",
    );
    for (const id of [
      "discover",
      "guide",
      "editing-guide",
      "native",
      "script",
      "direct",
      "verify",
      "scope",
    ])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    for (const id of ["local", "raw-local", "local-write", "local-copy", "unknown"])
      expect(getToolExecution(result, id).isError, id).toBe(true);
    expect(getToolResultText(result, "verify")).toContain("Direct\nLast line");
    expect(getToolExecutionDetails(getToolExecution(result, "unknown"))).toMatchObject({
      effect: "unknown",
    });
    expect(await readFile(path.join(cwd, "local.txt"), "utf8")).toBe("Local sentinel\n");
    const state = JSON.parse(
      await readFile(path.join(cwd, "github-fixture.json"), "utf8"),
    ) as GithubFixtureJournal;
    expect(state.issues["12"].body).toBe("External change\nLast line\n");
    expect(getToolResultText(result, "scope")).toContain("stale source rejected without PATCH");
    expect(
      state.requests.filter((request: { method: string }) => request.method === "POST"),
    ).toHaveLength(1);
    expect(state.issues["99"].body).toBe("Applied once");
    const direct = getToolExecution(result, "direct");
    expect(direct.toolName).toBe("github_replace");
    expect(getToolExecutionDetails(direct)).toMatchObject({
      mutationRender: [{ path: body, model: { added: 0, modified: 1, removed: 0 } }],
    });
    expect(stripVTControlCharacters(result.terminalOutput)).toMatch(/\+0\s+~1\s+-0/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
