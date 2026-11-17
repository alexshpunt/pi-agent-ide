import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SearchEnvironment } from "pi-agent-search/api/search";
import { searchText, searchTextContent } from "#src/search-backend.ts";

import { SearchCaptureGuard, SearchCaptureLimitError } from "#src/search-capture.ts";

test.each(["wire", "expanded"])("enforces the inclusive %s byte boundary", (kind) => {
  const capture = new SearchCaptureGuard();
  const add = (bytes: number) =>
    kind === "wire" ? capture.addOutput(bytes) : capture.addText(bytes / 2);
  expect(() => add(64 * 1024 * 1024)).not.toThrow();
  expect(() => add(2)).toThrow(SearchCaptureLimitError);
});
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "search-capture-"));
  directories.push(cwd);
  return cwd;
}
const minified = "needle ".repeat(160) + "x".repeat(256 * 1024) + "\n";

test.each(["file", "content"])(
  "rejects amplified line text before registering %s matches",
  async (kind) => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "bundle.js"), minified);
    const result =
      kind === "file"
        ? searchText({ query: "needle", path: "bundle.js", limit: 10 }, cwd)
        : searchTextContent({ query: "needle", limit: 10 }, minified, cwd);
    await expect(result).rejects.toMatchObject({ name: "SearchCaptureLimitError" });
    const recovered = await searchTextContent({ query: "needle" }, "needle\n", cwd);
    expect(recovered).toMatchObject({ complete: true, matches: [{ matchedText: "needle" }] });
  },
);

test("rejects too many short matches without silently reporting a complete prefix", async () => {
  const cwd = await fixture();
  await expect(
    searchTextContent({ query: "n", limit: 1 }, "n\n".repeat(50_001), cwd),
  ).rejects.toMatchObject({ name: "SearchCaptureLimitError" });
});
test("separate path captures share the expanded match bound", async () => {
  const cwd = await fixture();
  const content = "needle ".repeat(80) + "x".repeat(256 * 1024) + "\n";
  await Promise.all(["a.js", "b.js"].map((file) => writeFile(path.join(cwd, file), content)));
  expect((await searchText({ query: "needle", path: "a.js" }, cwd)).complete).toBe(true);
  await expect(
    searchText({ query: "needle", paths: ["a.js", "b.js"], limit: 1 }, cwd),
  ).rejects.toMatchObject({ name: "SearchCaptureLimitError" });
});

test("owned captures reject amplified events and abort their executor", async () => {
  let executionSignal: AbortSignal | undefined;
  const environment: SearchEnvironment = {
    resolve: (cwd, source) => (source.includes("://") ? source : `${cwd}/${source}`),
    dirname: (source) => source.slice(0, source.lastIndexOf("/")),
    basename: (source) => source.slice(source.lastIndexOf("/") + 1),
    isDirectory: async () => true,
    readText: async () => minified,
    async runLines(_args, _cwd, onLine, signal) {
      executionSignal = signal;
      onLine(
        JSON.stringify({
          type: "match",
          data: {
            path: { text: "bundle.js" },
            lines: { text: minified },
            line_number: 1,
            submatches: Array.from({ length: 160 }, (_, index) => ({
              start: index * 7,
              end: index * 7 + 6,
            })),
          },
        }),
      );
      return { code: 0, stderr: "" };
    },
  };
  await expect(
    searchText(
      { query: "needle", path: "memory://owner" },
      "/local",
      undefined,
      undefined,
      environment,
    ),
  ).rejects.toMatchObject({ name: "SearchCaptureLimitError" });
  expect(executionSignal?.aborted).toBe(true);
});
