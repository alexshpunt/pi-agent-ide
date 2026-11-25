import { expect, test, vi } from "vitest";
import type {
  LinearOperationBackend,
  LinearOperationCapability,
  LinearOperationReceipt,
} from "#linear/operation-backend.ts";
import { createLinearDomainResolver, readLinearDomain } from "#linear/domain-read.ts";

const id = "cc4a56e3-8306-4f29-a859-bbc94618630c";
const other = "bd884dfe-27ec-47f0-83d8-61f620e05091";
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const capabilities: LinearOperationCapability[] = [
  {
    name: "get_release",
    inputSchema: schema({ id: { type: "string" }, includeReleaseNotes: { type: "boolean" } }, [
      "id",
    ]),
    annotations: {},
  },
  {
    name: "list_releases",
    inputSchema: schema({
      limit: { type: "integer", minimum: 1, maximum: 250 },
      cursor: { type: "string" },
      query: { type: "string" },
      includeArchived: { type: "boolean" },
    }),
    annotations: {},
  },
  {
    name: "save_release",
    inputSchema: schema({ id: { type: "string" }, title: { type: "string" } }),
    annotations: {},
  },
  {
    name: "list_cycles",
    inputSchema: schema(
      { teamId: { type: "string" }, type: { type: "string", enum: ["current", "all"] } },
      ["teamId"],
    ),
    annotations: {},
  },
  { name: "get_workspace", inputSchema: schema({}), annotations: {} },
  {
    name: "list_issue_labels",
    inputSchema: schema({
      team: { type: "string" },
      limit: { type: "integer" },
      cursor: { type: "string" },
    }),
    annotations: {},
  },
  {
    name: "save_issue_label",
    inputSchema: schema({ id: { type: "string" }, name: { type: "string" } }),
    annotations: {},
  },
];
function backend(data: unknown) {
  const invoke = vi.fn(
    async (workspace: string, operation: string): Promise<LinearOperationReceipt> => ({
      workspace,
      operation,
      effect: "applied",
      data,
    }),
  );
  const result: LinearOperationBackend = { capabilities: async () => capabilities, invoke };
  return { result, invoke };
}

test("a release card is readonly and binds its identity instead of a query override", async () => {
  const b = backend({
    release: {
      id,
      name: "Version one",
      url: `https://linear.app/example/release/version-one/${id}`,
    },
  });
  const resolver = createLinearDomainResolver(b.result);
  const resolved = await resolver.tryResolve(`linear://example/release/${id}`, {
    cwd: process.cwd(),
  });
  expect(resolved.kind).toBe("resolved");
  if (resolved.kind !== "resolved") throw new Error("Not resolved");
  expect(resolved.resource).not.toHaveProperty("write");
  if (!resolved.resource.read) throw new Error("Not readable");
  const blocks = await resolved.resource.read({});
  expect(blocks).toHaveLength(1);
  const first = blocks.at(0);
  expect(first?.type === "text" && first.text).toContain("Version one");
  expect(b.invoke.mock.calls[0]).toEqual([
    "example",
    "get_release",
    { id },
    process.cwd(),
    undefined,
  ]);
  await expect(
    readLinearDomain(
      `linear://example/release/${id}?id=${other}`,
      process.cwd(),
      undefined,
      b.result,
    ),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_OVERRIDE" });
});

test("list continuations preserve filters and expose exact opaque cursors and total counts", async () => {
  const b = backend({
    releases: [{ id, name: "Version one" }],
    hasNextPage: true,
    cursor: "next/page",
    totalCount: 71,
  });
  const source = "linear://example/releases?query=release&includeArchived=false&limit=3";
  const text = await readLinearDomain(source, process.cwd(), undefined, b.result);
  const next =
    "linear://example/releases?query=release&includeArchived=false&limit=3&cursor=next%2Fpage";
  expect(text).toContain(`linear://example/release/${id}`);
  expect(text).toContain(next);
  expect(text).toContain("Total reported: 71");
  await readLinearDomain(next, process.cwd(), undefined, b.result);
  expect(b.invoke.mock.calls[1]).toEqual([
    "example",
    "list_releases",
    { query: "release", includeArchived: false, limit: 3, cursor: "next/page" },
    process.cwd(),
    undefined,
  ]);
});

test("required parent scope and typed query values reject before backend invocation", async () => {
  const b = backend([]);
  for (const source of [
    "linear://example/cycles",
    "linear://example/releases?includeArchived=no",
    "linear://example/releases?limit=51",
    "linear://example/releases?query=x&query=y",
    "linear://example/releases?unknown=x",
  ]) {
    await expect(
      readLinearDomain(source, process.cwd(), undefined, b.result),
    ).rejects.toMatchObject({ effect: "not-applied" });
  }
  expect(b.invoke).not.toHaveBeenCalled();
  await readLinearDomain(
    "linear://example/cycles?teamId=team-one&type=current",
    process.cwd(),
    undefined,
    b.result,
  );
  expect(b.invoke.mock.calls[0]).toEqual([
    "example",
    "list_cycles",
    { teamId: "team-one", type: "current" },
    process.cwd(),
    undefined,
  ]);
});

test("wrong workspace, response identity and malformed continuation never become successful cards", async () => {
  for (const data of [{ id: other }, { id, url: `https://linear.app/other/release/${id}` }]) {
    const b = backend(data);
    await expect(
      readLinearDomain(`linear://example/release/${id}`, process.cwd(), undefined, b.result),
    ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_MISMATCH" });
  }
  const b = backend({ releases: [], hasNextPage: true });
  await expect(
    readLinearDomain("linear://example/releases", process.cwd(), undefined, b.result),
  ).rejects.toMatchObject({ code: "LINEAR_PAGINATION_UNVERIFIED" });
  const w = backend({ url: "https://linear.app/other" });
  await expect(
    readLinearDomain("linear://example/workspace", process.cwd(), undefined, w.result),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_MISMATCH" });
});

test("bounded list lookup can read labels but never prove an absent item in an incomplete page", async () => {
  const b = backend({ labels: [{ id, name: "Bug" }], hasNextPage: false });
  expect(
    await readLinearDomain(
      `linear://example/label/${id}?team=ENG`,
      process.cwd(),
      undefined,
      b.result,
    ),
  ).toContain("Bug");
  const incomplete = backend({ labels: [], hasNextPage: true, cursor: "next" });
  await expect(
    readLinearDomain(
      `linear://example/label/${other}`,
      process.cwd(),
      undefined,
      incomplete.result,
    ),
  ).rejects.toMatchObject({ code: "LINEAR_LOOKUP_INCOMPLETE" });
});

test("existing native, document-body, auxiliary and field routes stay with their original resolvers", async () => {
  const b = backend({});
  const resolver = createLinearDomainResolver(b.result);
  for (const source of [
    "https://linear.app/example/issue/ENG-12/fixture",
    `linear://example/document/${id}`,
    `linear://example/document/${id}/content`,
    "linear://example/search/issues?q=word",
    `linear://example/resource/releases/${id}`,
    `linear://example/release/${id}#fields`,
    "https://example.org/page",
  ]) {
    expect(await resolver.tryResolve(source, { cwd: process.cwd() })).toEqual({
      kind: "not-handled",
    });
  }
  expect(b.invoke).not.toHaveBeenCalled();
});
