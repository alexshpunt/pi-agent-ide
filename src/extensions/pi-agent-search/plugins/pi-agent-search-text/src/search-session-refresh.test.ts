import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SearchScopeChangedError } from "pi-agent-search/api/search";
import { expect, onTestFinished, test } from "vitest";

import {
  SearchRefreshError,
  SearchSessionStore,
  type TextSearchMatch,
} from "#src/search-session.ts";

function match(
  source: string,
  lineNumber: number,
  lineText: string,
  word: string,
): TextSearchMatch {
  const startColumn = lineText.indexOf(word);
  return {
    source,
    lineNumber,
    startColumn,
    endColumn: startColumn + word.length,
    matchedText: word,
    lineText,
  };
}

async function workspace(content: string) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-refresh-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, content);
  return { cwd, source };
}

/** A store with one complete search whose refresh runs `refresh`, and a file changed since. */
async function changedSearch(
  refresh: (
    source: string,
    signal?: AbortSignal,
  ) => Promise<{
    matches: TextSearchMatch[];
    complete: boolean;
    contents?: ReadonlyMap<string, string>;
  }>,
) {
  const { cwd, source } = await workspace("Vec a;\n");
  const store = new SearchSessionStore();
  const session = await store.register(
    "Vec",
    [match(source, 1, "Vec a;", "Vec")],
    true,
    cwd,
    undefined,
    { query: "Vec", regex: false },
    (signal) => refresh(source, signal),
  );
  await writeFile(source, "// other agent\nVec a;\n");
  const resolve = async (signal?: AbortSignal) =>
    store
      .resourceResolver()
      .tryResolve(`SEARCH#${session.id}:all:match`, { cwd, ...(signal && { signal }) });
  return { source, resolve };
}

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected an Error");
}

test("a refresh uses the text its backend searched, not a second read another writer changed", async () => {
  const searched = "// other agent\nVec a;\n";
  const { source, resolve } = await changedSearch(async (file) => {
    // Another writer shifts the lines after the backend searched and before the session reads.
    await writeFile(file, "// other agent\n// and another\nVec a;\n");
    return {
      matches: [match(file, 2, "Vec a;", "Vec")],
      complete: true,
      contents: new Map([[file, searched]]),
    };
  });
  await expect(resolve()).resolves.toMatchObject({
    kind: "resolved",
    targets: [{ source, expectedContent: searched }],
  });
});

test("a refresh whose file changed again names the change and is marked for an edit retry", async () => {
  const { source, resolve } = await changedSearch(async (file) => {
    await writeFile(file, "// other agent\n// and another\nVec a;\n");
    return { matches: [match(file, 2, "Vec a;", "Vec")], complete: true };
  });
  const failure = await failureOf(resolve);
  expect(failure).toBeInstanceOf(SearchRefreshError);
  expect(failure).toMatchObject({ code: "SOURCE_CHANGED" });
  expect(failure.message).toContain(source);
  expect(failure.message).toContain("another process is writing it");
  expect(failure.message).toContain("Repeat the search");
});

test("a refresh whose scope left the file says so and how to continue", async () => {
  const { resolve } = await changedSearch(() =>
    Promise.reject(new SearchScopeChangedError("the scoped region was removed")),
  );
  const failure = await failureOf(resolve);
  expect(failure).toMatchObject({ code: "SCOPE_CHANGED" });
  expect(failure.message).toContain("the scoped region was removed");
  expect(failure.message).toContain("Run the search again");
});

test("an unexpected refresh failure keeps its reason and says what to do", async () => {
  const { resolve } = await changedSearch(() =>
    Promise.reject(new Error("ast-grep exited with 2")),
  );
  const failure = await failureOf(resolve);
  expect(failure).toMatchObject({ code: "REFRESH_FAILED" });
  expect(failure.message).toContain("ast-grep exited with 2");
  expect(failure.message).toContain("report it as a tool error");
});

test("a cancelled refresh stays a cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by the user");
  const { resolve } = await changedSearch(() => {
    controller.abort(reason);
    return Promise.reject(reason);
  });
  await expect(resolve(controller.signal)).rejects.toBe(reason);
});

test("a limited search and a refresh that outgrew its limit both say how to get every match", async () => {
  const { cwd, source } = await workspace("Vec a;\n");
  const store = new SearchSessionStore();
  const limited = await store.register("Vec", [match(source, 1, "Vec a;", "Vec")], false, cwd);
  const first = await store
    .resourceResolver()
    .tryResolve(`SEARCH#${limited.id}:all:match`, { cwd });
  expect(first).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
  expect(first.kind === "rejected" && first.rejection.reason).toContain("higher limit");

  const { resolve } = await changedSearch(async (file) => ({
    matches: [match(file, 2, "Vec a;", "Vec")],
    complete: false,
  }));
  const refreshed = await resolve();
  expect(refreshed).toMatchObject({ kind: "rejected", rejection: { code: "missing" } });
  expect(refreshed.kind === "rejected" && refreshed.rejection.reason).toMatch(
    /repeated search found more matches than its limit.*higher limit/u,
  );
});
