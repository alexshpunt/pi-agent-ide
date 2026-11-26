import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchCatalog,
  readCatalogTool,
  catalogAddress,
  parseCatalogAddress,
} from "#unity/catalog.ts";

const project = "C:\\dev\\Unity\\one";
const catalog = [
  {
    name: "scene_get_hierarchy",
    description: "Return the GameObject tree of an open scene",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  { name: "scene_list_open", description: "List open scenes", inputSchema: { type: "object" } },
  { name: "asset_find", description: "Find assets", inputSchema: { type: "object" } },
];

void test("finds selected tools by name and description without returning their schemas", () => {
  const result = searchCatalog(project, catalog, "scene hierarchy", 20);
  assert.deepEqual(
    result.items.map((item) => item.name),
    ["scene_get_hierarchy"],
  );
  assert.equal("inputSchema" in result.items[0], false);
  assert.equal(result.items[0].uri, catalogAddress(project, "scene_get_hierarchy"));
  assert.equal(result.complete, true);
});

void test("round-trips project and tool identities in catalog resource URIs", () => {
  assert.deepEqual(parseCatalogAddress(catalogAddress(project, "scene_get_hierarchy")), {
    project,
    name: "scene_get_hierarchy",
  });
  assert.deepEqual(parseCatalogAddress(catalogAddress(project)), { project, name: undefined });
  assert.throws(() => parseCatalogAddress("unity://project/%ZZ/tools"));
});
void test("reads one exact tool schema and rejects unknown or ambiguous names", () => {
  assert.deepEqual(readCatalogTool(catalog, "scene_get_hierarchy"), catalog[0]);
  assert.throws(() => readCatalogTool(catalog, "missing"));
  assert.throws(() => readCatalogTool([...catalog, catalog[0]], "scene_get_hierarchy"));
});

void test("reports truncated search results and enforces explicit queries", () => {
  assert.equal(searchCatalog(project, catalog, "scene", 1).complete, false);
  assert.throws(() => searchCatalog(project, catalog, "", 1));
});
