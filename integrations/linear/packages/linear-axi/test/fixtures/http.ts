import assert from "node:assert/strict";
import { jsonRecord } from "./json.ts";

export function fixtureString(value: unknown): string {
  assert(typeof value === "string", "Expected fixture text");
  return value;
}

export function fixtureRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function fixtureFormBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(fixtureString(body));
}

export function fixtureCallbackUrl(event: { url?: unknown; redirectUri?: unknown }, code: string): URL {
  const target = new URL(fixtureString(event.redirectUri));
  const authorization = new URL(fixtureString(event.url));
  target.searchParams.set("state", fixtureString(authorization.searchParams.get("state")));
  target.searchParams.set("code", code);
  return target;
}

export function fixtureJsonBody(init?: RequestInit): Record<string, unknown> {
  return jsonRecord(init?.body);
}

/** A deterministic gate for test races; resolving twice is harmless. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void = () => {
    throw new Error("Fixture gate resolver is unavailable");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}
