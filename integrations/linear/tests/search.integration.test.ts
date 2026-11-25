import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { currentIde } from "./fixtures/current-ide.ts";
import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const issue = "https://linear.app/example/issue/ENG-12/fixture-task";
const next = new URL("linear://example/search/issues");
next.searchParams.set("q", "body phrase");
next.searchParams.set("scope", "linear://example");
next.searchParams.set("limit", "2");
next.searchParams.set("cursor", "next/page");
test.each([false, true])(
  "native and scoped Search use real shared protocols in either load order (%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "search-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "tests/fixtures/axi.mjs") }),
      );
      const linear = path.join(root, "src/index.ts");
      const cores = [
        ide.extension,
        path.join(root, "tests/fixtures/generic-web.ts"),
        path.join(root, "tests/fixtures/scope-probe.ts"),
      ];
      const operations: [string, string, Record<string, unknown>][] = [
        ["guides", "read", { path: "docs:" }],
        [
          "native",
          "search",
          { query: "linear:issues body phrase", path: "linear://example", limit: 2 },
        ],
        ["next", "read", { path: next.href }],
        ["card", "read", { path: issue }],
        ["scoped", "search", { query: "Second", path: issue }],
        ["absent", "search", { query: "Full document", path: issue }],
        [
          "doc",
          "search",
          {
            query: "Full document",
            path: "linear://example/document/71000000-0000-4000-8000-000000000006",
          },
        ],
        ["teams", "search", { query: "linear:teams Engineering", path: "linear://example" }],
        [
          "team",
          "read",
          { path: "linear://example/resource/teams/71000000-0000-4000-8000-000000000003" },
        ],
        ["failure", "search", { query: "word", path: issue.replace("ENG-12", "ENG-13") }],
        ["web", "read", { path: "https://linear.app/developers/attachments" }],
        ["verify", "verify_scope", {}],
        ["guidance", "read", { path: "docs:linear" }],
      ];
      const result = await new PiIntegrationTest({
        testName: `linear-search-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: providerFirst ? [linear, ...cores] : [...cores, linear],
        tools: ["read", "search", "verify_scope"],
        timeoutMs: 60000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Find a Linear task and search only explicitly selected resources.");
      await ide.record(result.artifacts.directory);
      for (const id of [
        "native",
        "next",
        "card",
        "scoped",
        "absent",
        "doc",
        "teams",
        "team",
        "web",
      ])
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      const documentation = (id: string) => {
        const value = getToolExecution(result, id).result as {
          details?: { documentation?: { kind: string; ids?: string[]; id?: string } };
        };
        return value.details?.documentation;
      };
      expect(documentation("guides")?.kind).toBe("list");
      expect(documentation("guides")?.ids).toContain("linear");
      expect(documentation("native")?.kind).toBe("attachment");
      expect(documentation("native")?.ids).toContain("linear");
      expect(documentation("card")?.ids ?? []).not.toContain("linear");
      expect(getToolExecution(result, "guidance").isError).toBe(false);
      expect(documentation("guidance")).toMatchObject({ kind: "document", id: "linear" });
      expect(getToolResultText(result, "native")).toContain(issue);
      expect(getToolResultText(result, "native")).toContain("coverage is incomplete");
      expect(getToolResultText(result, "next")).toContain("End of results");
      expect(getToolResultText(result, "scoped")).toContain("Second line");
      expect(getToolResultText(result, "scoped")).toContain("RESULT#");
      expect(getToolExecutionDetails(getToolExecution(result, "absent"))).toMatchObject({
        payload: { mode: "text", matches: [], complete: true },
      });
      expect(getToolResultText(result, "doc")).toContain("Full document");
      expect(getToolResultText(result, "team")).toContain("Complete team card");
      expect(getToolResultText(result, "web")).toContain("Generic web content");
      expect(getToolExecution(result, "failure").isError).toBe(true);
      expect(getToolExecution(result, "verify").isError).toBe(false);
      expect(getToolResultText(result, "verify")).toContain("stale source rejected");
      expect(getToolResultText(result, "failure")).not.toContain("private-fixture-token");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  75000,
);
