import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTextResolver } from "#src/resolvers.js";
import { SearchSessionStore } from "#src/search-session.js";
import type { SearchRequest } from "pi-agent-search/api/search";

import { searchFuzzy } from "#src/fuzzy-search.js";
import { fuzzyLimits } from "pi-agent-search/api/search";
interface FuzzyData {
  readonly matches: readonly unknown[];
  readonly fuzzy?: {
    readonly status: "ready" | "skipped";
    readonly message?: string;
    readonly candidates: readonly {
      readonly identifier: string;
      readonly reason: string;
      readonly matchCount: number;
      readonly fileCount: number;
      readonly selection: {
        readonly complete: boolean;
        readonly matches: readonly { readonly references?: { readonly line?: string } }[];
        readonly all?: { readonly line?: string };
      };
    }[];
  };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});
async function fixture(): Promise<string> {
  const base = path.resolve(".tmp/fuzzy-search-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "case-"));
  directories.push(cwd);
  await mkdir(path.join(cwd, "src"));
  await writeFile(
    path.join(cwd, "src/hints.js"),
    [
      "const hintStrings = this.hintStrings(2);",
      "if (hintStrings.length) marker.hintString = hintStrings[0];",
      "hintStrings(linkCount) {}",
      "generateHintString(number) {}",
      "this.generateHintString(2);",
      "deleteHintStrings() {}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(cwd, "outside.js"), "generate_hint_strings();\n");
  return cwd;
}
async function resolve(request: SearchRequest, cwd: string, sessions = new SearchSessionStore()) {
  const resolver = createTextResolver(sessions);
  const context = { cwd };
  const attempt = await resolver.tryResolve(request, context);
  if (attempt.kind !== "resolved") throw new Error("Expected a resolved local search");
  const formatted = await resolver.format(attempt.payload, context);
  const data = resolver.toScriptData?.(attempt.payload, formatted.details) as FuzzyData;
  const text = formatted.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return { data, text, details: formatted.details };
}

test("offers real candidate groups and readable exact selections after a scoped zero result", async () => {
  const cwd = await fixture();
  const sessions = new SearchSessionStore();
  const result = await resolve(
    { query: "generateHintStrings", path: "src", include: "*.js" },
    cwd,
    sessions,
  );
  expect(result.data.matches).toEqual([]);
  expect(result.details).toHaveProperty("fuzzyPresentation.fileCount", 1);
  expect(result.data).not.toHaveProperty("fuzzyPresentation");
  expect(result.text).not.toContain("const hintStrings =");
  expect(JSON.stringify(result.data)).not.toContain("const hintStrings =");
  expect(result.data.fuzzy?.candidates.map((candidate) => candidate.identifier)).toEqual([
    "hintStrings",
    "generateHintString",
  ]);
  expect(result.data.fuzzy?.candidates).toMatchObject([
    { identifier: "hintStrings", matchCount: 5, fileCount: 1, selection: { complete: true } },
    { identifier: "generateHintString", matchCount: 2, fileCount: 1 },
  ]);
  expect(result.text).toContain("No matches found.");
  expect(result.text).toContain("hintStrings");
  expect(result.text).toContain("generateHintString");
  const reference = result.data.fuzzy?.candidates[0]?.selection.all?.line;
  expect(reference).toMatch(/^SEARCH#[A-F0-9]+:all:line$/u);
  if (!reference) throw new Error("Missing readable candidate selection");
  expect((await sessions.resourceResolver().tryResolve(reference, { cwd })).kind).toBe("resolved");
});

test("keeps the ordinary zero usable if candidate files vanish before registration", async () => {
  const cwd = await fixture();
  const resolver = createTextResolver(new SearchSessionStore());
  const context = { cwd };
  const attempt = await resolver.tryResolve({ query: "generateHintStrings", path: "src" }, context);
  if (attempt.kind !== "resolved") throw new Error("Expected a completed zero result");
  await rm(path.join(cwd, "src/hints.js"));
  const formatted = await resolver.format(attempt.payload, context);
  const data = resolver.toScriptData?.(attempt.payload, formatted.details) as FuzzyData;
  expect(data.matches).toEqual([]);
  expect(data.fuzzy?.candidates.every((candidate) => candidate.selection.all === undefined)).toBe(
    true,
  );
});

test("caps a repeated candidate capture without issuing an all reference", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, "src/hints.js"), "hintStrings();\n".repeat(500));
  const result = await resolve({ query: "generateHintStrings", path: "src" }, cwd);
  expect(result.data.fuzzy?.candidates).toHaveLength(1);
  expect(result.data.fuzzy?.candidates[0]).toMatchObject({
    matchCount: fuzzyLimits.matchesPerCandidate,
    selection: { complete: false },
  });
  expect(result.data.fuzzy?.candidates[0]?.selection.all).toBeUndefined();
  expect(result.data.fuzzy?.candidates[0]?.selection.matches[0]?.references?.line).toMatch(
    /^SEARCH#/u,
  );
  expect(result.text).toContain("Capture limit reached");
});
test("stops repeated-token collection at its byte budget and explains the skip", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, "src/hints.js"), "hintStrings\n".repeat(800_000));
  const result = await resolve({ query: "generateHintStrings", path: "src" }, cwd);
  expect(result.data.matches).toEqual([]);
  expect(result.data.fuzzy).toMatchObject({ status: "skipped", candidates: [] });
  expect(result.text).toContain("budget");
});
test("propagates user cancellation from the extra scan", async () => {
  const cwd = await fixture();
  const abort = new AbortController();
  const result = searchFuzzy({ query: "generateHintStrings", path: "src" }, cwd, abort.signal);
  abort.abort(new Error("user canceled"));
  await expect(result).rejects.toThrow("user canceled");
});
test("does not let ignored or hidden files suggest an out-of-scope name", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, ".git"));
  await writeFile(path.join(cwd, ".gitignore"), "ignored.js\n");
  await writeFile(path.join(cwd, "ignored.js"), "GenerateHintStrings();\n");
  await writeFile(path.join(cwd, ".hidden.js"), "GenerateHintStrings();\n");
  await rm(path.join(cwd, "outside.js"));
  const result = await resolve({ query: "generateHintStrings" }, cwd);
  expect(result.data.fuzzy?.candidates.map((candidate) => candidate.identifier)).toEqual([
    "hintStrings",
    "generateHintString",
  ]);
});
test("keeps candidate vocabularies and identities separate across checkouts", async () => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(path.join(second, "src/hints.js"), "hintStrings();\n");
  const store = new SearchSessionStore();
  const request = { query: "generateHintStrings", path: "src" };
  const a = await resolve(request, first, store);
  const b = await resolve(request, second, store);
  expect(a.data.fuzzy?.candidates[0]?.matchCount).toBe(5);
  expect(b.data.fuzzy?.candidates[0]?.matchCount).toBe(1);
  expect(a.data.fuzzy?.candidates[0]?.selection.all?.line).not.toBe(
    b.data.fuzzy?.candidates[0]?.selection.all?.line,
  );
  await rm(path.join(second, "src/hints.js"));
  expect((await resolve(request, second, store)).data.fuzzy).toBeUndefined();
});
test("refreshes a candidate all reference with its exact alternative, not the original fuzzy query", async () => {
  const cwd = await fixture();
  const sessions = new SearchSessionStore();
  const result = await resolve({ query: "generateHintStrings", path: "src" }, cwd, sessions);
  const all = result.data.fuzzy?.candidates[0]?.selection.all?.line;
  const first = result.data.fuzzy?.candidates[0]?.selection.matches[0]?.references?.line;
  if (!all || !first) throw new Error("Missing candidate references");
  await writeFile(
    path.join(cwd, "src/hints.js"),
    "hintStrings();\nHintStrings();\nmyhintStrings();\ngenerateHintStrings();\n",
  );
  const resources = sessions.resourceResolver();
  const refreshed = await resources.tryResolve(all, { cwd });
  expect(refreshed).toMatchObject({ kind: "resolved" });
  if (refreshed.kind !== "resolved") throw new Error("Missing refreshed selection");
  expect(refreshed.targets).toHaveLength(1);
  expect(refreshed.targets[0]?.ranges).toHaveLength(1);
  expect((await resources.tryResolve(first, { cwd })).kind).toBe("rejected");
});
test("bounds snapshot reads if a candidate file grows after capture", async () => {
  const cwd = await fixture();
  const resolver = createTextResolver(new SearchSessionStore());
  const context = { cwd };
  const attempt = await resolver.tryResolve({ query: "generateHintStrings", path: "src" }, context);
  if (attempt.kind !== "resolved") throw new Error("Expected a completed zero result");
  await writeFile(
    path.join(cwd, "src/hints.js"),
    "hintStrings();\n" + "x".repeat(fuzzyLimits.vocabularyBytes + 1),
  );
  const formatted = await resolver.format(attempt.payload, context);
  const data = resolver.toScriptData?.(attempt.payload, formatted.details) as FuzzyData;
  expect(data.matches).toEqual([]);
  expect(data.fuzzy?.message).toContain("without stable references");
  expect(data.fuzzy?.candidates.every((candidate) => candidate.selection.all === undefined)).toBe(
    true,
  );
});
test("does not refresh a complete candidate all reference into an unbounded partial selection", async () => {
  const cwd = await fixture();
  const sessions = new SearchSessionStore();
  const result = await resolve({ query: "generateHintStrings", path: "src" }, cwd, sessions);
  const all = result.data.fuzzy?.candidates[0]?.selection.all?.line;
  if (!all) throw new Error("Missing candidate all reference");
  await writeFile(path.join(cwd, "src/hints.js"), "hintStrings();\n".repeat(500));
  expect(await sessions.resourceResolver().tryResolve(all, { cwd })).toMatchObject({
    kind: "rejected",
    rejection: { code: "missing" },
  });
});
test("verifies dollar-prefixed identifier spelling without matching a larger name", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, "src/hints.js"), "$hintStrings();\nother$hintStrings();\n");
  const result = await resolve({ query: "$generateHintStrings", path: "src" }, cwd);
  expect(result.data.fuzzy?.candidates).toMatchObject([
    { identifier: "$hintStrings", matchCount: 1 },
  ]);
});
test("does not count a plain candidate inside a dollar-prefixed or suffixed identifier", async () => {
  const cwd = await fixture();
  await writeFile(
    path.join(cwd, "src/hints.js"),
    "hintStrings();\n$hintStrings();\nhintStrings$();\n",
  );
  const result = await resolve({ query: "generateHintStrings", path: "src" }, cwd);
  expect(
    result.data.fuzzy?.candidates.find((candidate) => candidate.identifier === "hintStrings")
      ?.matchCount,
  ).toBe(1);
});
test("uses fresh vocabulary after file edits and keeps exact queries out of the fallback", async () => {
  const cwd = await fixture();
  const request = { query: "generateHintStrings", path: "src" };
  const first = await resolve(request, cwd);
  expect(first.data.fuzzy?.candidates[0]?.identifier).toBe("hintStrings");
  await writeFile(path.join(cwd, "src/hints.js"), "const generate_hint_strings = 1;\n");
  expect(
    (await resolve(request, cwd)).data.fuzzy?.candidates.map((candidate) => candidate.identifier),
  ).toEqual(["generate_hint_strings"]);
  expect(
    (await resolve({ ...request, query: '"generateHintStrings"' }, cwd)).data.fuzzy,
  ).toBeUndefined();
  expect(
    (await resolve({ ...request, query: "generate_hint_strings" }, cwd)).data.fuzzy,
  ).toBeUndefined();
  expect((await resolve({ ...request, exclude: "*.js" }, cwd)).data.fuzzy).toBeUndefined();
});
