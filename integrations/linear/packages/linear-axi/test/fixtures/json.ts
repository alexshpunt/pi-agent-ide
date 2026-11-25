import assert from "node:assert/strict";
import { isRecord } from "#axi/types.ts";

export function fixtureRecord(value: unknown): Record<string, unknown> {
  assert(isRecord(value), "Expected a fixture record");
  return value;
}

export function jsonRecord(text: unknown): Record<string, unknown> {
  assert(typeof text === "string", "Expected JSON text");
  return fixtureRecord(JSON.parse(text));
}
