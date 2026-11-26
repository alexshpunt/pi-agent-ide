import { expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { selectNativeSearch, type NativeRegistry } from "#src/native-search.ts";
import { performSearch } from "#src/search.ts";

const active = { provider: "other", api: "other", id: "active", baseUrl: "https://example.com" };
const first = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "unsupported",
  name: "Fixture",
  baseUrl: "https://chatgpt.com",
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} satisfies Model<"openai-codex-responses">;
const second = { ...first, id: "supported" };
const registry = (oauth: boolean, observer = vi.fn((_model: unknown) => {})) =>
  ({
    getAvailable: () => [first, second],
    isUsingOAuth: () => oauth,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }),
    complete: async (model) => {
      observer(model);
      return {
        role: "assistant",
        content: [{ type: "text", text: "Codex answer" }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "supported",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  }) satisfies NativeRegistry;
const transport = Symbol.for("pi-web-search.runtime-transport");
const fetcher = vi.fn(async () =>
  Response.json({
    models: [
      { slug: "unsupported", supports_search_tool: false },
      { slug: "supported", supports_search_tool: true },
    ],
  }),
);

it("selects a supported subscription model independently of the active model", async () => {
  const selected = await selectNativeSearch({
    model: active,
    modelRegistry: registry(true),
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(selected?.model.id).toBe("supported");
  expect(selected?.adapter.id).toBe("openai-codex-responses");
});
it("does not use an otherwise supported active model when the subscription is unavailable", async () => {
  const openaiModel = {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.6",
    baseUrl: "https://api.openai.com/v1",
  };
  const selected = await selectNativeSearch({
    model: openaiModel,
    modelRegistry: registry(false),
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(selected).toBeUndefined();
});
it("does not use a Codex API key as a subscription", async () => {
  const selected = await selectNativeSearch({
    model: active,
    modelRegistry: registry(false),
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(selected).toBeUndefined();
});

it("uses only the external provider when no subscription is available", async () => {
  const original = (globalThis as Record<symbol, unknown>)[transport];
  const complete = vi.fn();
  (globalThis as Record<symbol, unknown>)[transport] = async () =>
    Response.json({ web: { results: [{ title: "Page", url: "https://example.com/page" }] } });
  try {
    const activeModel = {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.6",
      baseUrl: "https://api.openai.com/v1",
    };
    const result = await performSearch(
      { providers: [{ provider: "brave", apiKey: "key" }], strategy: "priority", fallback: true },
      { query: "q", maxResults: 5 },
      undefined,
      { activeModel, modelRegistry: registry(false, complete) },
    );
    expect(complete).not.toHaveBeenCalled();
    expect(result.native?.status).toBe("ineligible");
    expect(result.results).toHaveLength(1);
  } finally {
    if (original === undefined) delete (globalThis as Record<symbol, unknown>)[transport];
    else (globalThis as Record<symbol, unknown>)[transport] = original;
  }
});
it("combines subscription output with one external provider even when another model is active", async () => {
  const original = (globalThis as Record<symbol, unknown>)[transport];
  const complete = vi.fn((_model: unknown) => {});
  (globalThis as Record<symbol, unknown>)[transport] = async (url: string | URL | Request) =>
    (url instanceof Request ? url.url : String(url)).includes("/models?")
      ? fetcher()
      : Response.json({ web: { results: [{ title: "Page", url: "https://example.com/page" }] } });
  try {
    const result = await performSearch(
      { providers: [{ provider: "brave", apiKey: "key" }], strategy: "priority", fallback: true },
      { query: "q", maxResults: 5 },
      undefined,
      { activeModel: active, modelRegistry: registry(true, complete) },
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toEqual(second);
    expect(result.native).toMatchObject({
      status: "success",
      provider: "openai-codex",
      model: "supported",
    });
    expect(result.results).toHaveLength(1);
    expect((result as { answer?: string }).answer).toBe("Codex answer");
  } finally {
    if (original === undefined) delete (globalThis as Record<symbol, unknown>)[transport];
    else (globalThis as Record<symbol, unknown>)[transport] = original;
  }
});
