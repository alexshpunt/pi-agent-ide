import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { resourceScheduler } from "pi-agent-resource";
import { createSearchCore } from "#src/core/search-core.ts";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "#src/api/plugin-protocol.ts";
import type {
  SearchRequest,
  SearchContext,
  SearchResolutionAttempt,
  SearchResolverRegistration,
} from "#src/api/search.ts";

test.each([false, true])(
  "trusted Search API resolves scopes (array: %s) and guards them before any resolver runs",
  async (array) => {
    const targets = new ResultTargetStore();
    let blocked = false;
    const cwd = process.cwd();
    const reference = targets.register(
      [
        {
          source: "ssh://left/work/note.ts",
          expectedContent: "café\n",
          ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 4 } }],
          readCurrent: async () => {
            if (blocked) throw new Error("Owned content is blocked");
            return "café\n";
          },
        },
      ],
      cwd,
      false,
    );
    const core = createSearchCore(targets);
    const resolve = vi.fn((_request: SearchRequest, context: SearchContext) => {
      expect(context.scope?.complete).toBe(false);
      expect(context.scope?.targets[0]?.source).toBe("ssh://left/work/note.ts");
      return { kind: "resolved" as const, payload: [] };
    });
    await core.registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "scoped-reader",
      setup(api) {
        api.addResolver({
          resolver: {
            id: "text",
            supportsResultScope: true,
            tryResolve: resolve,
            format: () => ({ content: [{ type: "text", text: "No matches found." }], details: {} }),
            toScriptData: () => ({ kind: "matches", complete: false, matches: [] }),
          },
        });
      },
    });
    expect(
      (
        await core.execute(
          { query: "café", path: array ? [reference] : reference },
          { cwd },
          "script",
        )
      ).isError,
    ).not.toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
    blocked = true;
    const denied = await core.execute(
      { query: "café", path: array ? [reference] : reference },
      { cwd },
      "script",
    );
    expect(denied.isError).toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
    expect(JSON.stringify(denied.content)).toContain("Owned content is blocked");
  },
);
test("a script's search keeps structured data above the 1 MiB limit an agent's search has", async () => {
  const core = createSearchCore();
  const files = Array.from({ length: 20_000 }, (_, index) => `${"x".repeat(60)}-${String(index)}`);
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "large-files",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "files",
          tryResolve: () => ({ kind: "resolved", payload: files }),
          format: () => ({ content: [{ type: "text", text: "20000 files" }], details: {} }),
          toScriptData: () => ({ kind: "files", files, complete: true }),
        },
      });
    },
  });
  const script = await core.execute({ query: "large" }, { cwd: process.cwd() }, "script");
  expect(script.isError).not.toBe(true);
  expect(script.structuredContent).toMatchObject({ status: "success", data: { files } });
  const agent = await core.execute({ query: "large" }, { cwd: process.cwd() });
  expect(agent.isError).toBe(true);
  expect(JSON.stringify(agent.content)).toContain("exceeds 1 MiB");
});
async function setup(attempt: SearchResolutionAttempt | Error, supportsResultScope = false) {
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
        supportsResultScope,
        tryResolve: fallback,
        format: () => ({ content: [{ type: "text", text: "local hits" }], details: {} }),
      },
      fallback: true,
      priority: -100,
    },
    {
      resolver: {
        id: "special",
        supportsResultScope,
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
test("scope owner refusal prevents every resolver and failed setup retains no owner", async () => {
  const { core, specialized, fallback } = await setup({ kind: "resolved", payload: [] });
  let calls = 0;
  await expect(
    core.registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "refused-owner",
      setup(api) {
        api.addEnvironmentProvider(() => {
          calls += 1;
          throw new Error("UNKNOWN_TARGET");
        });
        throw new Error("setup rejected");
      },
    }),
  ).rejects.toThrow("setup rejected");
  await core.execute({ query: "needle" }, { cwd: process.cwd() });
  expect(calls).toBe(0);
  specialized.mockClear();
  fallback.mockClear();
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "owner",
    setup(api) {
      api.addEnvironmentProvider(() => {
        throw new Error("UNKNOWN_TARGET");
      });
    },
  });
  const result = await core.execute(
    { query: "needle", path: "ssh://missing/tmp" },
    { cwd: process.cwd() },
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("UNKNOWN_TARGET");
  expect(specialized).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});
test("issued-scope providers register atomically and refuse before resolver execution", async () => {
  const { core, specialized, fallback } = await setup({ kind: "resolved", payload: [] });
  const rejected = vi.fn(async () => {
    throw new Error("UNKNOWN_SCOPE");
  });
  await expect(
    core.registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "failed-issued-scope",
      setup(api) {
        api.addScopeProvider(rejected);
        throw new Error("setup rejected");
      },
    }),
  ).rejects.toThrow("setup rejected");
  await core.execute({ query: "needle", path: "note.txt" }, { cwd: process.cwd() });
  expect(rejected).not.toHaveBeenCalled();
  specialized.mockClear();
  fallback.mockClear();
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "issued-scope",
    setup(api) {
      api.addScopeProvider(rejected);
    },
  });
  const result = await core.execute(
    { query: "needle", path: "SEARCH#FFFF:all:line" },
    { cwd: process.cwd() },
  );
  expect(result.isError).toBe(true);
  expect(result.details.failure?.code).toBe("RESOLVE_FAILED");
  expect(result.details.failure?.message).toContain("UNKNOWN_SCOPE");
  expect(specialized).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
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
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "No matches found." });
    const warning = result.content[1];
    if (warning?.type !== "text") throw new Error("Missing coverage warning");
    expect(warning.text).toContain("incomplete");
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
  test("a literal colon prefix reaches the text fallback inside the unchanged result scope", async () => {
    const { core, fallback } = await setup({ kind: "not-handled" }, true);
    const scope = { targets: [], complete: true };
    const request = { query: 'feature: "legacy​Checkout"' };
    const result = await core.execute(request, { cwd: process.cwd(), scope });
    expect(result.details.resolverId).toBe("text");
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith(request, expect.objectContaining({ scope }));
    expect(fallback.mock.calls[0]?.[0]).toEqual(request);
    expect(JSON.stringify(result.content)).toContain("local hits");
  });
  test.each(["symbols:", "ast:", "regex:", "files:", "custom:   "])(
    "routes empty %s straight to local text",
    async (query) => {
      const { core, specialized, fallback } = await setup(new Error("service must stay idle"));
      const request = { query, path: "src", limit: 3, exclude: "*.test.ts" };
      const result = await core.execute(request, { cwd: process.cwd() });
      expect(specialized).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(request, { cwd: process.cwd() });
      expect(result.details.resolverId).toBe("text");
      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toEqual({ type: "text", text: "local hits" });
      const notice = result.content[0];
      if (notice?.type !== "text") throw new Error("Missing fallback notice");
      expect(notice.text).toContain("fallback");
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
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "text", text: "local hits" });
    const notice = result.content[0];
    if (notice?.type !== "text") throw new Error("Missing fallback notice");
    expect(notice.text).toContain("fallback");
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

describe("result scopes whose lines were edited", () => {
  const original = "one\ntwo\nthree\nfour\nfive\n";

  async function searchChangedScope(edited: string) {
    const directory = mkdtempSync(path.join(tmpdir(), "search-core-scope-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "note.txt");
    writeFileSync(file, original);
    const targets = new ResultTargetStore();
    const reference = targets.register(
      [
        {
          source: file,
          expectedContent: original,
          ranges: [{ start: { lineNumber: 2, column: 0 }, end: { lineNumber: 5, column: 0 } }],
        },
      ],
      directory,
    );
    writeFileSync(file, edited);
    const core = createSearchCore(targets);
    const seen: SearchContext[] = [];
    await core.registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "scoped-reader",
      setup(api) {
        api.addResolver({
          resolver: {
            id: "text",
            supportsResultScope: true,
            tryResolve: (_request, context) => {
              seen.push(context);
              return { kind: "resolved" as const, payload: [] };
            },
            format: () => ({ content: [{ type: "text", text: "No matches found." }], details: {} }),
            toScriptData: () => ({ kind: "matches", complete: true, matches: [] }),
          },
        });
      },
    });
    const result = await core.execute(
      { query: "x", path: reference },
      { cwd: directory },
      "script",
    );
    return { result, seen, targets, reference, directory };
  }

  test("are searched as the current text of their region, and the output says so", async () => {
    const { result, seen, targets, reference, directory } = await searchChangedScope(
      `zero\n${original.replace("three", "THREE")}`,
    );
    expect(result.isError).not.toBe(true);
    const range = seen[0]?.scope?.targets[0]?.ranges[0];
    expect(range).toMatchObject({
      start: { lineNumber: 3 },
      end: { lineNumber: 6 },
      adjusted: true,
    });
    expect(seen[0]?.rescope).toBeTypeOf("function");
    expect(JSON.stringify(result.content)).toContain("note.txt:3-5");
    // An edit would need the text that was selected.
    expect(() => targets.resolve(reference, directory)).toThrow(/expired/u);
  });

  test("say nothing when only lines around the region changed", async () => {
    const { result, seen } = await searchChangedScope(`zero\n${original}`);
    expect(seen[0]?.scope?.targets[0]?.ranges[0]?.adjusted).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain("changed after");
  });

  test("fail when the region is gone", async () => {
    const { result, seen } = await searchChangedScope("unrelated\n");
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});
