import assert from "node:assert/strict";

/** Return a required fixture value without making a missing one a successful assertion. */
export function required<T>(value: T | undefined | null): T {
  assert(value !== undefined && value !== null, "Missing fixture value");
  return value;
}

/** Parse fixture JSON as an object so tests can check its data without implicit types. */
export function jsonRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Build a deliberately partial host context for a test that supplies only the methods it invokes. */
export function fixtureHost<Host>(value: {
  [Key in keyof Host]?: Host[Key] extends object ? Partial<Host[Key]> : Host[Key];
}): Host {
  return value as Host;
}
