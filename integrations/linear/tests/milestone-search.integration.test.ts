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
const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000002";
const scope = `linear://example/project/${projectId}?milestone=Release`;
const pinned = `linear://example/project/${projectId}?milestone=${milestoneId}`;
function next(cursor: string) {
  const url = new URL("linear://example/search/issues");
  for (const [key, value] of Object.entries({ q: "release", scope: pinned, limit: "2", cursor }))
    url.searchParams.set(key, value);
  return url.href;
}
test.each([false, true])(
  "milestone issue Search and Read retain scope across an empty window (%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "milestone-search-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({
          axiPath: path.join(root, "tests/fixtures/milestone-search-axi.mjs"),
        }),
      );
      const linear = path.join(root, "src/index.ts");
      const operations: [string, string, Record<string, unknown>][] = [
        ["first", "search", { query: "linear:issues release", path: scope, limit: 2 }],
        ["empty", "read", { path: next("first-window") }],
        ["final", "read", { path: next("empty-window") }],
        [
          "invalid",
          "search",
          { query: "linear:issues release", path: "linear://example?milestone=Release" },
        ],
      ];
      const result = await new PiIntegrationTest({
        testName: `linear-milestone-search-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: providerFirst ? [linear, ide.extension] : [ide.extension, linear],
        tools: ["read", "search"],
        rawMode: false,
        timeoutMs: 60000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Find release issues in the selected milestone and follow its pages.");
      await ide.record(result.artifacts.directory);
      for (const id of ["first", "empty", "final"])
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      expect(getToolResultText(result, "first")).toContain("ENG-12");
      expect(getToolResultText(result, "first")).toContain(next("first-window"));
      expect(getToolResultText(result, "empty")).toContain(next("empty-window"));
      expect(getToolResultText(result, "empty")).not.toContain("ENG-");
      expect(getToolResultText(result, "final")).toContain("ENG-13");
      expect(getToolExecution(result, "invalid").isError).toBe(true);
      const calls: string[][] = (await readFile(path.join(cwd, "axi-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const searches = calls.filter(([group]) => group === "search");
      expect(searches).toHaveLength(3);
      for (const args of searches) expect(args[args.indexOf("--project-id") + 1]).toBe(projectId);
      expect(searches.map((args) => args[args.indexOf("--milestone") + 1])).toEqual([
        "Release",
        milestoneId,
        milestoneId,
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  75000,
);
