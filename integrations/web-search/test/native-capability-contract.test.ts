import { strict as assert } from "node:assert";
import type { Model } from "@earendil-works/pi-ai";
import type { NativeRegistry } from "#src/native-search.ts";
import { describe, expect, it, vi } from "vitest";
import { selectNativeSearch } from "#src/native-search.ts";
import { expectNativePromptContract } from "./support/native-prompt-contract.js";

const model = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.3-codex",
  name: "Fixture",
  baseUrl: "https://chatgpt.com/backend-api",
  input: ["text"],
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} satisfies Model<"openai-codex-responses">;
const active = { provider: "other", api: "other", id: "other", baseUrl: "https://example.com" };
const catalog = (records: unknown[] = [{ slug: model.id, supports_search_tool: true }]) =>
  Response.json({ models: records });
function runtime(
  auth: Awaited<ReturnType<NativeRegistry["getApiKeyAndHeaders"]>> = { ok: true, apiKey: "token" },
) {
  const getApiKeyAndHeaders = vi
    .fn<NativeRegistry["getApiKeyAndHeaders"]>()
    .mockResolvedValue(auth);
  const completeCalls = vi.fn((_model: unknown, _context: unknown, _options: unknown) => {});
  const response = {
    role: "assistant",
    content: [{ type: "text", text: "Search evidence" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  } satisfies Awaited<ReturnType<NativeRegistry["complete"]>>;
  const complete: NativeRegistry["complete"] = async (requested, context, options) => {
    completeCalls(requested, context, options);
    return response;
  };
  return {
    getAvailable: () => [model],
    isUsingOAuth: () => true,
    getApiKeyAndHeaders,
    complete,
    completeCalls,
  } satisfies NativeRegistry & { completeCalls: typeof completeCalls };
}
function input(
  registry: ReturnType<typeof runtime>,
  fetch: typeof globalThis.fetch,
  signal = new AbortController().signal,
) {
  return { model: active, modelRegistry: registry, signal, fetch };
}

describe("Codex subscription capability", () => {
  it("authenticates and fetches metadata for the available subscription model", async () => {
    const registry = runtime({
      ok: true,
      headers: { Authorization: "Bearer refreshed-token", "ChatGPT-Account-ID": "account" },
    });
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => catalog());
    const signal = new AbortController().signal;
    const selected = await selectNativeSearch(input(registry, fetch, signal));
    expect(selected?.model).toEqual(model);
    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    assert.ok(call);
    const [url, init] = call;
    const parsed = new URL(url instanceof Request ? url.url : String(url));
    expect(parsed.origin + parsed.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(parsed.searchParams.get("client_version")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(init).toMatchObject({
      signal,
      headers: { Authorization: "Bearer refreshed-token", "ChatGPT-Account-ID": "account" },
    });
  });

  it("uses Pi completion and enables the live search tool", async () => {
    const registry = runtime();
    const fetch = vi.fn(async () => catalog());
    const selected = await selectNativeSearch(input(registry, fetch));
    assert.ok(selected);
    const result = await selected.adapter.search({
      query: "What changed in 2026?",
      model: selected.model,
      modelRegistry: registry,
      signal: new AbortController().signal,
      fetch,
    });
    expect(result).toMatchObject({
      text: "Search evidence",
      provider: "openai-codex",
      model: model.id,
    });
    const call = registry.completeCalls.mock.calls[0];
    assert.ok(call);
    const context = call[1] as {
      messages: Array<{ content: unknown }>;
    };
    expectNativePromptContract(context.messages[0]?.content, "What changed in 2026?");
    const opts = call[2];
    assert.ok(
      typeof opts === "object" &&
        opts !== null &&
        "onPayload" in opts &&
        typeof opts.onPayload === "function",
    );
    const onPayload = opts.onPayload as (payload: unknown, selected: typeof model) => unknown;
    expect(onPayload({ tools: [] }, model)).toMatchObject({
      model: model.id,
      tools: [{ type: "web_search", external_web_access: true }],
      store: false,
      stream: true,
    });
  });

  it.each([
    ["disabled", [{ slug: model.id, supports_search_tool: false }]],
    ["absent", [{ slug: "another", supports_search_tool: true }]],
  ])("does not select an %s model", async (_name, records) => {
    const fetch = vi.fn(async () => catalog(records));
    expect(await selectNativeSearch(input(runtime(), fetch))).toBeUndefined();
  });

  it.each([
    ["missing catalog", {}],
    ["malformed capability", { models: [{ slug: model.id, supports_search_tool: "yes" }] }],
    [
      "duplicate model",
      {
        models: [
          { slug: model.id, supports_search_tool: true },
          { slug: model.id, supports_search_tool: true },
        ],
      },
    ],
  ])("reports invalid metadata: %s", async (_name, body) => {
    const fetch = vi.fn(async () => Response.json(body));
    await expect(selectNativeSearch(input(runtime(), fetch))).rejects.toBeInstanceOf(Error);
  });

  it("ignores malformed unrelated records and reacquires metadata on each search", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        catalog([
          { slug: "unrelated", supports_search_tool: "bad" },
          { slug: model.id, supports_search_tool: true },
        ]),
      )
      .mockResolvedValueOnce(catalog([]));
    const params = input(runtime(), fetch);
    expect(await selectNativeSearch(params)).toBeDefined();
    expect(await selectNativeSearch(params)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ok: true, apiKey: "resolved", headers: { "x-runtime": "pi" } }, "Bearer resolved"],
    [
      { ok: true, apiKey: "ignored", headers: { authorization: "Basic existing" } },
      "Basic existing",
    ],
    [{ ok: true, headers: { AuThOrIzAtIoN: "Bearer mixed" } }, "Bearer mixed"],
  ] as const)("preserves authentication headers", async (auth, expected) => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => catalog());
    await selectNativeSearch(input(runtime(auth), fetch));
    const call = fetch.mock.calls[0];
    assert.ok(call);
    const headers = new Headers(call[1]?.headers);
    expect(headers.get("authorization")).toBe(expected);
    expect([...headers.keys()].filter((key) => key.toLowerCase() === "authorization")).toHaveLength(
      1,
    );
  });

  it("reports authentication failure without contacting the catalog", async () => {
    const fetch = vi.fn(async () => catalog());
    await expect(
      selectNativeSearch(input(runtime({ ok: false, error: "private" }), fetch)),
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates cancellation of catalog lookup", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const pending = selectNativeSearch(input(runtime(), fetch, controller.signal));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    () => new Response("secret-response-body", { status: 503 }),
    () => new Response("secret-malformed-body"),
  ])("does not leak catalog response bodies on failure", async (response) => {
    const fetch = vi.fn(async () => response());
    const error = await selectNativeSearch(input(runtime(), fetch)).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/secret-response-body|secret-malformed-body/);
  });
});
