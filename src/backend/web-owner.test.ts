import { expect, test, vi } from "vitest";
import { createWebResolver } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/resolver.js";
import { createSshWebResolver, parseSshWebSource } from "./web-owner.js";
import { SshBackendRegistry } from "./registry.js";

const source = "web:ssh://fixture/https://example.test/note";

test("an explicit target web source cannot fall through to a local resource", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const browser = { load: vi.fn() };
  const convert = vi.fn();
  const resolver = createWebResolver({ convert }, { fetch, browser });
  const result = await resolver.tryResolve(source, { cwd: "/controller" });
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") throw new Error("Target source was not claimed");
  expect(String(result.error)).toContain(source);
  expect(fetch).not.toHaveBeenCalled();
  expect(browser.load).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
});

test("target web delegation preserves owner errors and never invokes local HTTP or browser", async () => {
  const error = new Error("Target refused this URL");
  const target = {
    id: "owned",
    tryResolve: vi.fn(async () => ({ kind: "failed" as const, error })),
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const browser = { load: vi.fn() };
  const resolver = createWebResolver({ convert: vi.fn() }, { fetch, browser, owner: target });
  const controller = new AbortController();
  const context = { cwd: "/controller", signal: controller.signal };
  await expect(resolver.tryResolve(source, context)).resolves.toEqual({ kind: "failed", error });
  expect(target.tryResolve).toHaveBeenCalledWith(source, context);
  expect(fetch).not.toHaveBeenCalled();
  expect(browser.load).not.toHaveBeenCalled();
});

test("target web parsing preserves the nested URL and refuses non-HTTP or ambiguous ownership", () => {
  const requested = "web:ssh://fixture/https://example.test/a%20b?x=42#section";
  expect(parseSshWebSource(requested)?.source).toBe(requested);
  expect(parseSshWebSource(requested)?.url.href).toBe("https://example.test/a%20b?x=42#section");
  expect(parseSshWebSource("https://example.test")).toBeUndefined();
  for (const invalid of [
    "web:ssh://user@fixture/https://example.test",
    "web:ssh://fixture:22/https://example.test",
    "web:ssh://fixture/file:///etc/passwd",
    "web:ssh://fixture/https://user:password@example.test",
    "web:ssh://fixture/",
  ])
    expect(() => parseSshWebSource(invalid)).toThrow("INVALID_SOURCE");
});

test("an unknown web target preserves the requested source without probing another endpoint", async () => {
  const host = { convert: vi.fn() };
  const selected = "web:ssh://missing/https://example.test";
  const result = await createSshWebResolver(host, new SshBackendRegistry([])).tryResolve(selected, {
    cwd: "/controller",
  });
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") throw new Error("Unknown target was not refused");
  expect(result.error).toMatchObject({
    code: "UNKNOWN_TARGET",
    source: selected,
    effect: "not-applied",
  });
  expect(host.convert).not.toHaveBeenCalled();
});
