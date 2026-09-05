import { describe, expect, test, vi } from "vitest";
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
