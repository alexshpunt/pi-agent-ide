import { expect, it, vi } from "vitest";
import type { SearchSelectionMatch, SearchSelectionProvider } from "pi-agent-ide/api/search";
import { GithubConnections } from "#github/connections/manager.ts";
import { createGithubSearchResolver } from "#github/search.ts";
import { MemoryStore } from "./fixtures/memory-connections.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("does not register A's Search matches as B when switching during the worker", async () => {
  const store = new MemoryStore();
  for (const id of ["a", "b"])
    await store.saveProfile(
      { id, label: id, kind: "pat" },
      { kind: "pat", token: `fixture-private-${id}` },
    );
  await store.setProjectDefault("/project", "a");
  const connections = new GithubConnections({ store, legacyConfig: async () => undefined });
  const started = deferred<void>();
  const worker = deferred<SearchSelectionMatch[]>();
  const matchText = async () => {
    started.resolve();
    return worker.promise;
  };
  const register = vi.fn<SearchSelectionProvider>(async (selection) => ({
    id: "fixture",
    matches: selection.matches,
    complete: selection.complete,
  }));
  const source = "github://example/project/issues/12#body";
  const resolver = createGithubSearchResolver(
    async () => {
      throw new Error("Object discovery is outside this test");
    },
    async () => ({ source, content: "First line\n" }),
    register,
    connections,
    matchText,
  );
  try {
    const pending = resolver.tryResolve({ path: source, query: "First" }, { cwd: "/project" });
    await started.promise;
    connections.useProfile("b");
    worker.resolve([
      {
        source,
        lineNumber: 1,
        startColumn: 0,
        endColumn: 5,
        matchedText: "First",
        lineText: "First line",
      },
    ]);
    expect((await pending).kind).toBe("failed");
    expect(register).not.toHaveBeenCalled();
    expect((await connections.capture("/project")).profile.id).toBe("b");
  } finally {
    connections.dispose();
    vi.restoreAllMocks();
  }
});
