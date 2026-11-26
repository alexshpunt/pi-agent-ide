import { test } from "node:test";
import assert from "node:assert/strict";
import { createUnitySearch } from "#unity/search.ts";

const context = { cwd: "/" };

void test("searches a project tool catalog and returns a readable tool URI", async () => {
  const project = "C:\\Unity\\project";
  const path = `unity://project/${encodeURIComponent(project)}/tools`;
  const resolver = createUnitySearch(
    async () => {
      throw new Error("Full catalog text should not be read");
    },
    async (actual) => {
      assert.equal(actual, project);
      return [
        {
          name: "scene_get_hierarchy",
          description: "Return a scene hierarchy",
          inputSchema: { type: "object" },
        },
      ];
    },
  );
  const found = await resolver.tryResolve({ path, query: "scene hierarchy" }, context);
  assert.equal(found.kind, "resolved");
  const out = await resolver.format(found.payload, context);
  assert.match(JSON.stringify(out.content), /scene_get_hierarchy/);
  assert.match(JSON.stringify(out.details), /unity:\/\/project\//);
  assert.doesNotMatch(JSON.stringify(out.details), /inputSchema/);
});
void test("does not fall back when project catalog discovery fails", async () => {
  const resolver = createUnitySearch(
    async () => {
      throw new Error("unexpected fallback");
    },
    async () => {
      throw new Error("editor unavailable");
    },
  );
  const result = await resolver.tryResolve(
    { path: "unity://project/C%3A%5Cmissing/tools", query: "scene" },
    context,
  );
  assert.equal(result.kind, "failed");
});
void test("search claims Unity resources and refuses foreign scopes", async () => {
  const resolver = createUnitySearch(async () => "Alpha\nbeta\nALPHA");
  assert.equal(
    (await resolver.tryResolve({ path: "file:///tmp/a", query: "a" }, context)).kind,
    "not-handled",
  );
  const found = await resolver.tryResolve({ path: "unity://projects", query: "alpha" }, context);
  assert.equal(found.kind, "resolved");
  const out = await resolver.format(found.payload, context);
  assert.match(JSON.stringify(out.content), /2 matches/);
  assert.equal(
    (await resolver.tryResolve({ path: "unity://bad", query: "regex:a" }, context)).kind,
    "failed",
  );
});
