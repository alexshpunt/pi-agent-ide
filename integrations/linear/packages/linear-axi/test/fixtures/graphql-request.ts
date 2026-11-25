import assert from "node:assert/strict";
import { fixtureRecord, jsonRecord } from "./json.ts";

export interface FixtureGraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** Parse the client's actual HTTP request before inspecting it in a fixture. */
export function fixtureGraphqlRequest(init?: RequestInit): FixtureGraphqlRequest {
  const parsed = jsonRecord(init?.body);
  assert(typeof parsed.query === "string");
  return { ...parsed, query: parsed.query, variables: fixtureRecord(parsed.variables ?? {}) };
}

export function fixtureGraphqlOperation(query: string): string {
  const name = /(?:query|mutation)\s+(\w+)/u.exec(query)?.[1];
  assert(name, "Expected a named GraphQL fixture operation");
  return name;
}
