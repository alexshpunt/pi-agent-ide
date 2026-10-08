import { describe, expect, test, vi } from "vitest";
import { resourceScheduler } from "pi-agent-resource";
import { createSearchCore } from "#src/core/search-core.js";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "#src/api/plugin-protocol.js";
import type {
  SearchRequest,
  SearchResolutionAttempt,
  SearchResolverRegistration,
} from "#src/api/search.js";

async function setup(attempt: SearchResolutionAttempt | Error) {
  const core = createSearchCore();
  const specialized = vi.fn(() => {
    if (attempt instanceof Error) throw attempt;
    return attempt;
  });
  const fallback = vi.fn((_request: SearchRequest) => ({
    kind: "resolved" as const,
    payload: "local",
  }));
  const registrations: SearchResolverRegistration[] = [
    {
      resolver: {
        id: "text",
        tryResolve: fallback,
        format: () => ({ content: [{ type: "text", text: "local hits" }], details: {} }),
      },
      fallback: true,
      priority: -100,
    },
    {
      resolver: {
        id: "special",
        tryResolve: specialized,
        format: () => ({ content: [{ type: "text", text: "No symbols found." }], details: {} }),
      },
      priority: 200,
    },
  ];
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "fixture",
    setup(api) {
      for (const registration of registrations) api.addResolver(registration);
    },
  });
  return { core, specialized, fallback };
}

test("search waits for conflicting writes without blocking a disjoint query", async () => {
  const core = createSearchCore();
  const observed: string[] = [];
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "concurrency",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "memory",
          readResources: (request) => [request.query],
          tryResolve(request) {
            observed.push(request.query);
            return { kind: "resolved", payload: request.query };
          },
          format: () => ({ content: [{ type: "text", text: "found" }], details: {} }),
        },
      });
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = resourceScheduler.run([{ resource: "memory:blocked", mode: "write" }], () => gate);
  const blocked = core.execute({ query: "memory:blocked" }, { cwd: process.cwd() });
  try {
    await core.execute({ query: "memory:other" }, { cwd: process.cwd() });
    expect(observed).toEqual(["memory:other"]);
  } finally {
    release();
    await Promise.allSettled([writer, blocked]);
  }
  expect(observed).toEqual(["memory:other", "memory:blocked"]);
});
test.each([false, true])("search readers overlap with a declared scope=%s", async (declared) => {
  const core = createSearchCore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    release();
  }, 1000);
  const entered: string[] = [];
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "reader-overlap",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "reader-overlap",
          ...(declared && { readResources: (request: SearchRequest) => [request.query] }),
          async tryResolve(request) {
            entered.push(request.query);
            if (request.query === "memory:first") await gate;
            else release();
            return { kind: "resolved", payload: request.query };
          },
          format: () => ({ content: [{ type: "text", text: "found" }], details: {} }),
          toScriptData: () => ({ kind: "custom", resolverId: "reader-overlap", value: "found" }),
        },
      });
    },
  });
  try {
    const results = await Promise.all(
      ["memory:first", "memory:second"].map((query) =>
        core.execute({ query }, { cwd: process.cwd() }),
      ),
    );
    expect(timedOut).toBe(false);
    expect(entered).toEqual(["memory:first", "memory:second"]);
    expect(results.map((result) => result.details.resolverId)).toEqual([
      "reader-overlap",
      "reader-overlap",
    ]);
  } finally {
    clearTimeout(watchdog);
    release();
  }
});
test("script search keeps resolver data and formatted reference data separately", async () => {
  const { core } = await setup({ kind: "resolved", payload: [{ path: "a.ts", line: 4 }] });
  const result = await core.execute({ query: "symbols:entry" }, { cwd: process.cwd() }, "script");
  expect(result.script).toEqual({
    resolverId: "special",
    data: [{ path: "a.ts", line: 4 }],
    details: {},
  });
  const ordinary = await core.execute({ query: "symbols:entry" }, { cwd: process.cwd() });
  expect(ordinary.script).toBeUndefined();
});
test.each(["ast:call($ARG)", "symbols:entry", "ast:", "symbols:"])(
  "does not turn unsupported scoped %s into text search",
  async (query) => {
    const core = createSearchCore();
    const fallback = vi.fn(() => ({ kind: "resolved" as const, payload: "wrong" }));
    await core.registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "text-only",
      setup(api) {
        api.addResolver({
          fallback: true,
          resolver: {
            id: "text",
            supportsResultScope: true,
            tryResolve: fallback,
            format: () => ({ content: [{ type: "text", text: "Wrong fallback" }], details: {} }),
          },
        });
      },
    });
    const result = await core.execute(
      { query },
      { cwd: process.cwd(), scope: { targets: [], complete: true } },
    );
    expect(result.details.failure?.code).toBe("NO_RESOLVER");
    expect(fallback).not.toHaveBeenCalled();
  },
);

test("rejects reference navigation for non-LSP queries before dispatch", async () => {
  const { core, fallback, specialized } = await setup({ kind: "not-handled" });
  const result = await core.execute(
    { query: "ast:call($ARG)", navigation: "references" },
    { cwd: process.cwd() },
  );
  expect(result.details.failure?.code).toBe("INVALID_REQUEST");
  expect(fallback).not.toHaveBeenCalled();
  expect(specialized).not.toHaveBeenCalled();
});
test.each(["matches", "files"] as const)(
  "warns about incomplete %s coverage without turning it into an error",
  async (kind) => {
    const core = createSearchCore();
    const data =
      kind === "matches"
        ? { kind, matches: [], complete: false }
        : { kind, files: [], complete: false };
    await core.registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "incomplete",
      setup(api) {
        api.addResolver({
          resolver: {
            id: "incomplete",
            tryResolve: () => ({ kind: "resolved", payload: data }),
            format: () => ({ content: [{ type: "text", text: "No matches found." }], details: {} }),
            toScriptData: () => data,
          },
        });
      },
    });
    const result = await core.execute({ query: "missing" }, { cwd: process.cwd() });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "success", data });
    expect(result.content).toContainEqual({
      type: "text",
      text: "Search coverage is incomplete. Do not conclude absence or use this result as an edit scope.",
    });
  },
);

test("keeps complete zero-match results free of incomplete warnings", async () => {
  const core = createSearchCore();
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "complete-zero",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "complete-zero",
          tryResolve: () => ({ kind: "resolved", payload: undefined }),
          format: () => ({ content: [{ type: "text", text: "No matches found." }], details: {} }),
          toScriptData: () => ({ kind: "matches", matches: [], complete: true }),
        },
      });
    },
  });
  const result = await core.execute({ query: "missing" }, { cwd: process.cwd() });
  expect(result.structuredContent).toMatchObject({ status: "success", data: { complete: true } });
  expect(result.content).toEqual([{ type: "text", text: "No matches found." }]);
});

describe("search fallback dispatch", () => {
  test.each(["symbols:", "ast:", "regex:", "files:", "custom:   "])(
    "routes empty %s straight to local text",
    async (query) => {
      const { core, specialized, fallback } = await setup(new Error("service must stay idle"));
      const request = { query, path: "src", limit: 3, exclude: "*.test.ts" };
      const result = await core.execute(request, { cwd: process.cwd() });
      expect(specialized).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(request, { cwd: process.cwd() });
      expect(result.details.resolverId).toBe("text");
      expect(result.content).toContainEqual({
        type: "text",
        text: "Search fallback: empty protocol query; searched the original text.",
      });
    },
  );
  test("tries specialized resolvers before fallback regardless of numeric priority", async () => {
    const { core, fallback } = await setup({ kind: "resolved", payload: [] });
    expect(
      (await core.execute({ query: "symbols:missing" }, { cwd: process.cwd() })).details.resolverId,
    ).toBe("special");
    expect(fallback).not.toHaveBeenCalled();
  });
  test("searches the original unknown prefix after all specialists decline", async () => {
    const { core, fallback } = await setup({ kind: "not-handled" });
    const result = await core.execute({ query: "unknown:needle" }, { cwd: process.cwd() });
    expect(fallback.mock.calls[0]?.[0]).toEqual({ query: "unknown:needle" });
    expect(result.details.resolverId).toBe("text");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Search fallback: unhandled protocol query; searched the original text.",
    });
  });
  test.each([new Error("service down"), { kind: "failed", error: new Error("timeout") } as const])(
    "keeps resolver failures visible",
    async (attempt) => {
      const { core, fallback } = await setup(attempt);
      const result = await core.execute({ query: "symbols:needle" }, { cwd: process.cwd() });
      expect(result.details.failure?.code).toBe("RESOLVE_FAILED");
      expect(result.isError).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
    },
  );
  test("cancellation does not dispatch to a fallback", async () => {
    const { core, fallback, specialized } = await setup({ kind: "not-handled" });
    const controller = new AbortController();
    controller.abort();
    const result = await core.execute(
      { query: "symbols:" },
      { cwd: process.cwd(), signal: controller.signal },
    );
    expect(result.details.failure?.code).toBe("RESOLVE_FAILED");
    expect(fallback).not.toHaveBeenCalled();
    expect(specialized).not.toHaveBeenCalled();
  });
  test("keeps a completely empty request invalid", async () => {
    const { core, fallback, specialized } = await setup({ kind: "not-handled" });
    expect(
      (await core.execute({ query: "   " }, { cwd: process.cwd() })).details.failure?.code,
    ).toBe("INVALID_REQUEST");
    expect(fallback).not.toHaveBeenCalled();
    expect(specialized).not.toHaveBeenCalled();
  });
});
