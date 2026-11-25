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
const uuid = "71000000-0000-4000-8000-000000000001";
const stable = `linear://example/project/${uuid}`;
const native = "https://linear.app/example/project/empty-cde012345678";
function continuation(scope: string) {
  const url = new URL("linear://example/search/issues");
  for (const [key, value] of Object.entries({
    q: "scope",
    scope,
    limit: "1",
    cursor: "next/page",
  }))
    url.searchParams.set(key, value);
  return url.href;
}

// Pattern: the extension example drives real tools with scripted assistant responses.
// Contract: empty native cards read successfully; project discovery and every page stay scoped.
test.each([false, true])(
  "empty project routes and scoped discovery work in either load order (%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "project-routes-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "tests/fixtures/project-routes-axi.mjs") }),
      );
      const linear = path.join(root, "src/index.ts");
      const operations: [string, string, Record<string, unknown>][] = [
        ["stable-card", "read", { path: stable }],
        ["native-card", "read", { path: native }],
        ["overview", "read", { path: native + "/overview" }],
        ["stable-search", "search", { query: "linear:issues scope", path: stable, limit: 1 }],
        ["stable-next", "read", { path: continuation(stable) }],
        ["native-search", "search", { query: "linear:issues scope", path: native, limit: 1 }],
        ["native-next", "read", { path: continuation(native) }],
        [
          "invalid",
          "search",
          {
            query: "linear:issues scope",
            path: stable + "/description",
          },
        ],
        // A status filter is not a scope parameter; the refusal says how to list by status.
        [
          "status-filter",
          "search",
          {
            query: "linear:issues scope",
            path: stable + "?status=Backlog",
          },
        ],
      ];
      const refused = ["invalid", "status-filter"];
      const result = await new PiIntegrationTest({
        testName: `linear-project-routes-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: providerFirst ? [linear, ide.extension] : [ide.extension, linear],
        tools: ["read", "search"],
        timeoutMs: 60000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Read an empty project and find matching issues only in that project.");
      await ide.record(result.artifacts.directory);
      for (const [id] of operations.filter(([id]) => !refused.includes(id)))
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      for (const id of ["stable-card", "native-card", "overview"])
        expect(getToolResultText(result, id)).toContain("Empty project");
      for (const id of ["native-card", "overview"]) {
        expect(getToolResultText(result, id)).toContain(`URL: ${native}`);
        expect(getToolResultText(result, id)).toContain("Resources (0)");
      }
      for (const [scope, first, next] of [
        [stable, "stable-search", "stable-next"],
        [native, "native-search", "native-next"],
      ]) {
        expect(getToolResultText(result, first)).toContain("ENG-12");
        expect(getToolResultText(result, first)).toContain(continuation(scope));
        expect(getToolResultText(result, next)).toContain("ENG-13");
        expect(getToolResultText(result, next)).toContain("End of results");
        for (const id of [first, next])
          expect(getToolResultText(result, id)).not.toContain("ENG-99");
      }
      for (const id of refused) {
        expect(getToolExecution(result, id).isError).toBe(true);
        expect(getToolResultText(result, id)).toContain("LINEAR_INVALID_SEARCH_SCOPE");
        expect(getToolResultText(result, id)).toContain("docs:linear-discovery");
        expect(getToolResultText(result, id)).toContain("filtered GraphQL");
      }
      const calls: string[][] = (await readFile(path.join(cwd, "axi-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const searches = calls.filter(([group]) => group === "search");
      expect(searches).toHaveLength(4);
      for (const args of searches) expect(args[args.indexOf("--project-id") + 1]).toBe(uuid);
      expect(searches.filter((args) => args.includes("--cursor"))).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  75000,
);
