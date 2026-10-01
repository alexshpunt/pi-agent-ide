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
import { afterEach, expect, test } from "vitest";

const ide = path.resolve("src/pi-agent-ide.ts");
const runtimeAnchors = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const root = path.resolve(".agents/tmp/hybrid-search-integration");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "case-"));
  directories.push(dir);
  return dir;
}
function call(id: string, name: string, arguments_: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: arguments_ })], {
    stopReason: "toolUse",
  });
}

test("runs hybrid matching and empty protocol recovery through the default IDE", async () => {
  const cwd = await workspace();
  await writeFile(
    path.join(cwd, "exact.txt"),
    "foo.bar\nfooXbar\ncall(\nsymbols:\nast:\nregex:\nfiles:\nlsp:\nunknown:needle\n",
  );
  await writeFile(
    path.join(cwd, "regex.txt"),
    "fooXbar\nfoo42 keep.me\nbar7 keep.me\nbar7 keep.me ignored\nfoo42 keepXme\n",
  );
  const queries = [
    { id: "literal", query: "foo.bar", path: "exact.txt" },
    { id: "regex", query: "foo.bar", path: "regex.txt" },
    { id: "quoted", query: '"foo.bar"', path: "regex.txt" },
    { id: "invalid-present", query: "call(", path: "exact.txt" },
    { id: "invalid-absent", query: "call(", path: "regex.txt" },
    {
      id: "boolean",
      query: String.raw`(?:foo|bar)\d+ AND "keep.me" NOT ignored`,
      path: "regex.txt",
    },
    { id: "explicit", query: "regex:foo.bar", path: "exact.txt" },
    ...["symbols:", "ast:", "regex:", "files:", "lsp:", "unknown:needle"].map((query, index) => ({
      id: `prefix-${index}`,
      query,
      path: "exact.txt",
    })),
  ];
  const result = await new PiIntegrationTest({
    testName: "hybrid-search-default-ide",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [ide],
    tools: ["search"],
    timeoutMs: 180_000,
    conversation: [
      ...queries.map(({ id, ...args }) => call(id, "search", args)),
      assistantMessage([text("Done")]),
    ],
  }).run("Search literals, regex fallbacks, quoted terms, Boolean expressions, and protocol text");
  for (const query of queries)
    expect(getToolExecution(result, query.id).isError, query.id).toBe(false);
  const output = (id: string) => getToolResultText(result, id);
  expect(output("literal")).toContain("⟦foo.bar⟧");
  expect(output("literal")).not.toContain("fooXbar");
  expect(output("regex")).toContain("⟦fooXbar⟧");
  expect(output("regex")).toContain("Search fallback:");
  expect(output("quoted")).toBe("No matches found.");
  expect(output("invalid-present")).toContain("⟦call(⟧");
  expect(output("invalid-absent")).toContain("invalid regex skipped");
  expect(output("boolean")).toContain("⟦foo42⟧ keep.me");
  expect(output("boolean")).toContain("⟦bar7⟧ keep.me");
  expect(output("boolean")).not.toContain("keepXme");
  expect(output("boolean")).not.toContain("keep.me ignored");
  expect(output("explicit")).toContain("⟦fooXbar⟧");
  for (const [index, prefix] of [
    "symbols:",
    "ast:",
    "regex:",
    "files:",
    "lsp:",
    "unknown:needle",
  ].entries()) {
    expect(output(`prefix-${index}`)).toContain(`⟦${prefix}⟧`);
    expect(output(`prefix-${index}`)).toContain("Search fallback:");
    expect(getToolExecutionDetails(getToolExecution(result, `prefix-${index}`))).toMatchObject({
      resolverId: "text",
    });
  }
});

test("finds Boolean matches and registers literal anchors after a regex error on long lines", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "boolean.txt"), "gpt-6-astra " + "x".repeat(32_000) + "\n");
  await writeFile(path.join(cwd, "unicode.txt"), "astra " + "aĀ".repeat(16_000) + "\n");
  const result = await new PiIntegrationTest({
    testName: "search-long-line-regressions",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [ide, runtimeAnchors],
    tools: ["search", "read"],
    timeoutMs: 180_000,
    rawMode: false,
    conversation: [
      call("invalid", "search", { query: "regex:(", path: "boolean.txt" }),
      call("boolean", "search", { query: "gpt-6-astra OR astra", path: "boolean.txt", limit: 1 }),
      call("boolean-match", "read", { path: "SEARCH#RUNTIME:1:all:match" }),
      call("literal", "search", { query: "astra", path: "unicode.txt", limit: 1 }),
      call("literal-match", "read", { path: "SEARCH#RUNTIME:2:all:match" }),
      assistantMessage([text("Done")]),
    ],
  }).run("Search long ASCII and Unicode lines and read the exact anchors after a failed regex");
  expect(getToolExecution(result, "invalid").isError).toBe(true);
  for (const id of ["boolean", "boolean-match", "literal", "literal-match"])
    expect(getToolExecution(result, id).isError, id).toBe(false);
  expect(getToolResultText(result, "boolean")).toContain("⟦gpt-6-astra⟧");
  expect(getToolResultText(result, "boolean-match")).toContain("gpt-6-astra");
  expect(getToolResultText(result, "literal")).toContain("⟦astra⟧");
  expect(getToolResultText(result, "literal-match")).toContain("astra");
  expect(getToolExecutionDetails(getToolExecution(result, "boolean"))).toMatchObject({
    payload: { matchCount: 1, complete: true },
  });
});
test("keeps Boolean conditions when refreshing an all-match anchor after editing", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "input.txt"), "alpha beta\n");
  const result = await new PiIntegrationTest({
    testName: "boolean-search-anchor-refresh",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [ide, runtimeAnchors],
    tools: ["search", "write", "read"],
    timeoutMs: 180_000,
    conversation: [
      call("search", "search", { query: "alpha AND beta NOT ignored", path: "input.txt" }),
      call("change", "write", {
        path: "input.txt",
        content: "alpha alone\nalpha beta ignored\nβ alpha beta\n",
      }),
      call("refresh", "read", { path: "SEARCH#RUNTIME:1:all:match" }),
      assistantMessage([text("Done")]),
    ],
  }).run("Refresh a Boolean selection after the matching lines change");
  for (const id of ["search", "change", "refresh"])
    expect(getToolExecution(result, id).isError, id).toBe(false);
  expect(getToolResultText(result, "refresh")).toContain("alpha");
  expect(getToolResultText(result, "refresh")).not.toContain("alone");
  expect(getToolResultText(result, "refresh")).not.toContain("ignored");
});
test("refreshes a regex fallback as literal-first before reading and editing all matches", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "input.txt"), "fooXbar\n");
  const result = await new PiIntegrationTest({
    testName: "hybrid-search-anchor-refresh",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [ide, runtimeAnchors],
    tools: ["search", "write", "read", "replace"],
    timeoutMs: 180_000,
    conversation: [
      call("search", "search", { query: "foo.bar", path: "input.txt" }),
      call("read-original", "read", { path: "SEARCH#RUNTIME:1:all:match" }),
      call("change", "write", { path: "input.txt", content: "foo.bar\nfooYbar\n" }),
      call("read-refreshed", "read", { path: "SEARCH#RUNTIME:1:all:match" }),
      call("replace", "replace", { path: "SEARCH#RUNTIME:1:all:match", text: "done" }),
      assistantMessage([text("Done")]),
    ],
  }).run("Use fallback search anchors, then refresh them after an exact match appears");
  for (const id of ["search", "read-original", "change", "read-refreshed", "replace"]) {
    expect(getToolExecution(result, id).isError, id).toBe(false);
  }
  expect(getToolResultText(result, "read-original")).toContain("fooXbar");
  expect(getToolResultText(result, "read-refreshed")).toContain("foo.bar");
  expect(getToolResultText(result, "read-refreshed")).not.toContain("fooYbar");
  expect(await readFile(path.join(cwd, "input.txt"), "utf8")).toBe("done\nfooYbar\n");
});
