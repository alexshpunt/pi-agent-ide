import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { textLineAnchors } from "pi-agent-ide/api/text";
import { currentIde } from "./fixtures/current-ide.ts";

const root = githubPackageRoot;
const fixture = path.join(root, "tests/fixtures/provider.ts");
const issue = "github://example/project/issues/12";
const body = issue + "#body";

// Pattern: real-Pi extensions example, native umbrella tools and a local HTTP-boundary fixture.
// Contract: shared resource tools preserve remote identity, exact scopes and unknown effects.
test.each([false, true])(
  "GitHub shared tools preserve identities and snapshots in both load orders (providerFirst=%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "github-provider-"));
    try {
      await writeFile(path.join(cwd, "local.txt"), "Local source stays local\n");
      await writeFile(
        path.join(cwd, "github-fixture.json"),
        JSON.stringify({
          issues: {
            "12": {
              number: 12,
              id: 12,
              title: "Original fixture",
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
      const [firstAnchor, lastAnchor] = textLineAnchors(body, "First line\nLast line\n");
      const operations: [string, string, Record<string, unknown>][] = [
        ["guides", "read", { path: "docs:" }],
        ["entry-guide", "read", { path: "docs:github" }],
        ["issues-guide", "read", { path: "docs:github-issues" }],
        ["local", "read", { path: "local.txt" }],
        ["native", "read", { path: "https://github.com/example/project/issues/12" }],
        ["body", "read", { path: body, views: ["anchors"] }],
        ["body-window", "read", { path: body, offset: 2, limit: 1, views: ["anchors"] }],
        ["edit", "replace", { path: body, at: firstAnchor, text: "Changed" }],
        ["verify-edit", "read", { path: body }],
        ["fields", "read", { path: issue + "#fields" }],
        ["save-title", "write", { path: issue + "#title", content: "Changed fixture title" }],
        ["verify-fields", "read", { path: issue + "#fields" }],
        [
          "native-search",
          "search",
          { query: "github:issues Changed", path: "github://example/project", limit: 2 },
        ],
        ["literal-search", "search", { query: "Last line", path: body }],
        ["absent-search", "search", { query: "Not present in fixture", path: body }],
        ["schema", "read", { path: "github://example/project/issues/new" }],
        [
          "create",
          "write",
          {
            path: "github://example/project/issues/new",
            content: JSON.stringify({
              title: "Created fixture",
              body: "Created through shared Write",
            }),
          },
        ],
        ["created", "read", { path: "github://example/project/issues/99" }],
        [
          "comment",
          "write",
          {
            path: issue + "/comments/new",
            content: JSON.stringify({ body: "Comment through shared Write" }),
          },
        ],
        ["comment-body", "read", { path: "github://example/project/issues/comments/34#body" }],
        ["scope", "verify_github_scope", {}],
        ["not-found", "read", { path: "github://example/project/issues/404" }],
        [
          "unknown",
          "write",
          {
            path: "github://example/project/issues/new",
            content: JSON.stringify({
              title: "simulate-unknown",
              body: "Saved before connection failed",
            }),
          },
        ],
      ];
      const result = await new PiIntegrationTest({
        testName: `github-provider-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: providerFirst ? [fixture, ide.extension] : [ide.extension, fixture],
        tools: ["read", "search", "replace", "write", "verify_github_scope"],
        timeoutMs: 90_000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished the GitHub provider fixture.")]),
        ],
      }).run(
        "Use GitHub only through shared resource tools. Keep local resources local and do not replay an unknown remote mutation.",
      );
      await ide.record(result.artifacts.directory);
      for (const [id] of operations.filter(([id]) => !["not-found", "unknown"].includes(id))) {
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      }
      const documentation = (id: string) =>
        (
          getToolExecution(result, id).result as {
            details?: { documentation?: { kind: string; ids?: string[]; id?: string } };
          }
        ).details?.documentation;
      expect(documentation("guides")).toMatchObject({ kind: "list" });
      expect(documentation("guides")?.ids).toEqual(
        expect.arrayContaining(["github", "github-issues"]),
      );
      expect(documentation("entry-guide")).toMatchObject({
        kind: "document",
        id: "github",
        owner: "agent-documentation-read",
      });
      expect(documentation("issues-guide")).toMatchObject({
        kind: "document",
        id: "github-issues",
        owner: "agent-documentation-read",
      });
      expect(getToolResultText(result, "local")).toContain("Local source stays local");
      expect(getToolResultText(result, "native")).toContain(issue);
      expect(getToolResultText(result, "body")).toContain(`${firstAnchor}|First line`);
      expect(getToolResultText(result, "body-window")).toContain(`${lastAnchor}|Last line`);
      expect(getToolResultText(result, "verify-edit")).toContain("Changed\nLast line");
      expect(getToolResultText(result, "verify-fields")).toContain("Changed fixture title");
      expect(getToolResultText(result, "native-search")).toContain(issue);
      expect(getToolResultText(result, "literal-search")).toContain("Last line");
      expect(getToolResultText(result, "literal-search")).toContain("RESULT#");
      expect(getToolExecutionDetails(getToolExecution(result, "absent-search"))).toMatchObject({
        resolverId: "github",
        payload: { mode: "text", matches: [], complete: true },
      });
      expect(getToolResultText(result, "create")).toContain("github://example/project/issues/99");
      expect(getToolResultText(result, "created")).toContain("Created through shared Write");
      expect(getToolResultText(result, "comment")).toContain(
        "github://example/project/issues/comments/34",
      );
      expect(getToolResultText(result, "comment-body")).toContain("Comment through shared Write");
      expect(getToolResultText(result, "scope")).toContain("stale source rejected without PATCH");
      expect(getToolExecution(result, "not-found").isError).toBe(true);
      expect(getToolExecution(result, "unknown").isError).toBe(true);
      expect(getToolExecutionDetails(getToolExecution(result, "unknown"))).toMatchObject({
        effect: "unknown",
      });
      const state = JSON.parse(await readFile(path.join(cwd, "github-fixture.json"), "utf8")) as {
        issues: Record<string, { title: string; body: string }>;
        comments: { body: string }[];
        requests: { method: string; path: string; query: string; body?: { title?: string } }[];
      };
      expect(state.issues["12"]).toMatchObject({
        title: "Changed fixture title",
        body: "External change\nLast line\n",
      });
      expect(state.issues["99"]).toMatchObject({
        title: "Created fixture",
        body: "Created through shared Write",
      });
      expect(state.comments).toEqual([
        expect.objectContaining({ body: "Comment through shared Write" }),
      ]);
      expect(
        state.requests.filter(
          (request) => request.method === "POST" && request.body?.title === "simulate-unknown",
        ),
      ).toHaveLength(1);
      expect(state.issues["100"].body).toBe("Saved before connection failed");
      const searchRequest = state.requests.find((request) => request.path === "/search/issues");
      expect(searchRequest).toBeDefined();
      expect(new URLSearchParams(searchRequest?.query).get("q")).toContain("repo:example/project");
      for (const [id] of operations)
        expect(getToolResultText(result, id)).not.toContain("private-fixture-token");
      expect(result.terminalOutput).toContain("Changed fixture title");
      expect(getToolResultText(result, "create")).toContain(
        "https://github.com/example/project/issues/99",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
