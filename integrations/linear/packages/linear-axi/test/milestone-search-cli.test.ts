import test from "node:test";
import assert from "node:assert/strict";
import { searchCommand } from "#axi/commands/search.ts";
import { decode } from "@toon-format/toon-v4";
import type { Runtime } from "#axi/types.ts";
import type { NativeSearchInput } from "#axi/lib/native-search.ts";
import { fixtureRecord } from "./fixtures/json.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000002";
const args = ["issues", "--query", "release", "--workspace", "example", "--project-id", projectId];
function fixture(rows: unknown, workspace = "example") {
  const calls: Array<[string, unknown]> = [];
  const searches: NativeSearchInput[] = [];
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.test/mcp",
    client: {
      listTools: async () => [{ name: "get_workspace" }, { name: "list_milestones" }],
      callTool: async (name: string, input: unknown) => {
        calls.push([name, input]);
        return {
          structuredContent:
            name === "get_workspace" ? { url: `https://linear.app/${workspace}` } : rows,
        };
      },
    },
    searchClient: {
      searchObjects: async (input) => {
        searches.push(input);
        return { ...input, items: [], totalCount: 0, hasMore: false, postFiltered: true };
      },
    },
  };
  return { runtime, calls, searches };
}
void test("CLI resolves a project-local milestone UUID or exact name before dispatch", async () => {
  for (const reference of [milestoneId.toUpperCase(), "0.8.2 - Release", "0.8.2 - release"]) {
    const f = fixture([
      { id: milestoneId, name: "0.8.2 - Release" },
      { id: projectId, name: "Other release" },
    ]);
    const result = fixtureRecord(
      decode(await searchCommand([...args, "--milestone", reference], f.runtime)),
    );
    assert.equal(f.searches.length, 1);
    assert.equal(f.searches[0]?.milestoneId, milestoneId);
    assert.equal(fixtureRecord(result.search).milestoneId, milestoneId);
    assert.deepEqual(f.calls, [
      ["get_workspace", {}],
      ["list_milestones", { project: projectId }],
    ]);
  }
});
void test("CLI never searches issues for unknown, ambiguous, incomplete or foreign milestones", async () => {
  for (const rows of [
    [],
    [{ id: projectId, name: "Other" }],
    [
      { id: milestoneId, name: "Release" },
      { id: projectId, name: "Release" },
    ],
    { milestones: [{ id: milestoneId, name: "Release" }], hasNextPage: true },
    [{ id: "invalid", name: "Release" }],
  ]) {
    const f = fixture(rows);
    await assert.rejects(() => searchCommand([...args, "--milestone", "Release"], f.runtime));
    assert.equal(f.searches.length, 0);
  }
  const foreign = fixture([{ id: milestoneId, name: "Release" }], "other");
  await assert.rejects(
    () => searchCommand([...args, "--milestone", milestoneId], foreign.runtime),
    { message: "LINEAR_IDENTITY_MISMATCH" },
  );
  assert.equal(foreign.searches.length, 0);
});
void test("CLI rejects milestone constraints outside canonical project issue scope before any request", async () => {
  for (const argv of [
    ["projects", ...args.slice(1)],
    ["documents", ...args.slice(1)],
    args.slice(0, -2),
    [...args.slice(0, -1), "project-name"],
  ]) {
    const f = fixture([]);
    await assert.rejects(() => searchCommand([...argv, "--milestone", milestoneId], f.runtime));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.searches, []);
  }
});
