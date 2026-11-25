import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@toon-format/toon-v4";
import { NativeWorkflowClient } from "#axi/native-workflow.ts";
import { fixtureGraphqlRequest, type FixtureGraphqlRequest } from "./fixtures/graphql-request.ts";
import { fixtureRecord } from "./fixtures/json.ts";
import { unexpectedSearch } from "./fixtures/native-search.ts";
import { isLinearOperation, isReadOnlyOperation } from "#axi/lib/operation-catalog.ts";
import { run } from "#axi/cli.ts";
import type { Runtime } from "#axi/types.ts";

const id = "10000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const org = { id: "30000000-0000-4000-8000-000000000003", urlKey: "example" };
const teamId = "40000000-0000-4000-8000-000000000004";
const operations = [
  "delete_document",
  "delete_workflow_skill",
  "delete_workflow_template",
] as const;
type DeleteOperation = (typeof operations)[number];
type Request = FixtureGraphqlRequest & { mutation: boolean };
interface Options {
  templateType?: "issue" | "document";
  team?: boolean;
  inherited?: boolean;
  workspace?: string;
  wrongId?: boolean;
  documentUrl?: string;
  preflight?: Response;
  mutate?: (request: Request) => unknown;
  changeAfter?: "read" | "mutation";
  changeOnAuthorization?: number;
  shared?: boolean;
  personal?: boolean;
  trashed?: boolean;
}
function fixture(options: Options = {}) {
  const requests: Request[] = [];
  const present = new Set([id, otherId]);
  let authCalls = 0;
  let changed = false;
  let trashed = options.trashed ?? false;
  const organization = { ...org, urlKey: options.workspace ?? org.urlKey };
  const actualId = options.wrongId ? otherId : id;
  const client = new NativeWorkflowClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      getAuthorization: async () => {
        authCalls++;
        if (authCalls === options.changeOnAuthorization) changed = true;
        return "Bearer private-delete-fixture-token";
      },
      assertCurrentAuthorization: async () => {
        if (changed) throw Error("LINEAR_AUTH_CONTEXT_CHANGED");
      },
    },
    fetchImpl: async (_url, init) => {
      const parsed = fixtureGraphqlRequest(init);
      const request: Request = { ...parsed, mutation: parsed.query.startsWith("mutation ") };
      requests.push(request);
      assert.deepEqual(
        request.variables,
        request.query.includes("WorkflowTeam") ? { id: teamId } : { id },
      );
      if (request.mutation) {
        const forced = await options.mutate?.(request);
        if (forced instanceof Response) return forced;
        if (forced !== undefined) return Response.json({ data: forced });
        if (options.changeAfter === "mutation") changed = true;
        if (request.query.includes("documentDelete")) {
          trashed = true;
          return Response.json({
            data: {
              deleted: {
                success: true,
                entity: {
                  id,
                  title: "Fixture document",
                  url: "https://linear.app/example/document/fixture-123456789abc",
                  slugId: "123456789abc",
                  trashed: true,
                  archivedAt: "2026-01-01T00:00:00.000Z",
                },
              },
            },
          });
        }
        present.delete(id);
        return Response.json({ data: { deleted: { success: true, entityId: id } } });
      }
      if (options.preflight) return options.preflight;
      if (options.changeAfter === "read") changed = true;
      const data = {
        viewer: { organization },
        team: { id: teamId, organization },
        skill: {
          id: actualId,
          title: "Fixture skill",
          body: "Fixture body",
          shared: options.shared ?? true,
          teamId: options.personal ? null : teamId,
          inheritedFrom: options.inherited ? { id: otherId } : null,
          owner: { organization },
          icon: null,
          color: null,
        },
        template: {
          id: actualId,
          name: "Fixture template",
          type: options.templateType ?? "issue",
          description: null,
          templateData: "{}",
          content: null,
          organization,
          team: options.team ? { id: teamId, organization } : null,
          inheritedFrom: options.inherited ? { id: otherId } : null,
          icon: null,
          color: null,
          sortOrder: 0,
        },
        document: {
          id: actualId,
          title: "Fixture document",
          url: options.documentUrl ?? "https://linear.app/example/document/fixture-123456789abc",
          slugId: "123456789abc",
          trashed,
          archivedAt: trashed ? "2026-01-01T00:00:00.000Z" : null,
        },
      };
      return Response.json({ data });
    },
  });
  return {
    client,
    requests,
    present,
    get authCalls() {
      return authCalls;
    },
    get trashed() {
      return trashed;
    },
  };
}
const invoke = (
  f: ReturnType<typeof fixture>,
  operation: DeleteOperation,
  input: unknown = { id },
) => f.client.invoke(operation, input, "example");

void test("native delete capabilities remain fixed, UUID-only and destructive", () => {
  const capabilities = fixture().client.capabilities();
  for (const operation of operations) {
    const capability = capabilities.find((value) => value.name === operation);
    assert(capability, operation);
    assert.equal(isLinearOperation(operation), true);
    assert.equal(isReadOnlyOperation(operation), false);
    assert(capability.annotations);
    assert.equal(capability.annotations.destructiveHint, true);
    assert.equal(capability.annotations.readOnlyHint, false);
    assert.equal(capability.inputSchema.additionalProperties, false);
    assert.deepEqual(capability.inputSchema.required, ["id"]);
    assert.deepEqual(Object.keys(fixtureRecord(capability.inputSchema.properties)), ["id"]);
  }
});

void test("invalid delete identities and overrides fail before authorization or HTTP", async () => {
  for (const operation of operations)
    for (const input of [
      {},
      { id: "new" },
      { id: "not-a-uuid" },
      { id, permanentlyDelete: true },
      { id, ifParentDocumentId: otherId },
    ]) {
      const f = fixture();
      const result = await invoke(f, operation, input);
      assert.equal(result.effect, "not-applied");
      assert.equal(result.error, "LINEAR_INPUT_INVALID");
      assert.equal(f.authCalls, 0);
      assert.deepEqual(f.requests, []);
    }
});

void test("native delete changes only the selected skill or either template type and scope", async () => {
  for (const [operation, options] of [
    ["delete_workflow_skill", {}],
    ["delete_workflow_template", { templateType: "issue" }],
    ["delete_workflow_template", { templateType: "document", team: true }],
  ] as const) {
    const f = fixture(options);
    const result = await invoke(f, operation);
    assert.equal(result.effect, "applied", result.error);
    assert.equal(result.error, undefined);
    assert.equal(result.targetId, id);
    assert.equal(f.present.has(id), false);
    assert.equal(f.present.has(otherId), true);
    assert.equal(f.requests.filter((request) => request.mutation).length, 1);
    assert(!f.requests.some((request) => /documentDelete/.test(request.query)));
  }
});

void test("document deletion uses standard trash semantics and preserves other documents", async () => {
  const f = fixture();
  const result = await invoke(f, "delete_document");
  assert.equal(result.effect, "applied", result.error);
  assert.equal(result.targetId, id);
  assert.equal(f.trashed, true);
  assert.equal(f.present.has(otherId), true);
  const mutations = f.requests.filter((request) => request.mutation);
  assert.equal(mutations.length, 1);
  assert(mutations[0].query.includes("documentDelete"));
  assert.deepEqual(mutations[0].variables, { id });
  assert(!mutations[0].query.includes("ifParentDocumentId"));
});

void test("foreign workspaces and mismatched target identities cannot dispatch deletion", async () => {
  for (const operation of operations)
    for (const options of [{ workspace: "foreign" }, { wrongId: true }]) {
      const f = fixture(options);
      const result = await invoke(f, operation);
      assert.equal(result.effect, "not-applied");
      assert.equal(result.error, "LINEAR_IDENTITY_MISMATCH");
      assert.equal(f.requests.filter((request) => request.mutation).length, 0);
      assert.equal(f.present.has(id), true);
    }
  for (const url of [
    "https://linear.app/foreign/document/fixture-123456789abc",
    "https://untrusted.invalid/example/document/fixture-123456789abc",
  ]) {
    const f = fixture({ documentUrl: url });
    assert.equal((await invoke(f, "delete_document")).effect, "not-applied");
    assert.equal(f.requests.filter((request) => request.mutation).length, 0);
  }
});

void test("inherited skills and templates cannot redirect a delete to their source", async () => {
  for (const operation of ["delete_workflow_skill", "delete_workflow_template"] as const) {
    const f = fixture({ inherited: true });
    assert.equal((await invoke(f, operation)).effect, "not-applied");
    assert.equal(f.requests.filter((request) => request.mutation).length, 0);
  }
});

void test("team-scoped skills can be deleted without workspace-wide sharing", async () => {
  for (const shared of [false, true]) {
    const f = fixture({ shared });
    const result = await invoke(f, "delete_workflow_skill");
    assert.equal(result.effect, "applied", result.error);
    assert.equal(result.targetId, id);
    assert.equal(f.present.has(id), false);
    assert.equal(f.present.has(otherId), true);
    assert.equal(f.requests.filter((request) => request.mutation).length, 1);
  }
});
void test("personal skills remain outside workflow deletion regardless of workspace sharing", async () => {
  for (const options of [
    { shared: false, personal: true },
    { shared: true, personal: true },
  ]) {
    const f = fixture(options);
    const result = await invoke(f, "delete_workflow_skill");
    assert.equal(result.effect, "not-applied");
    assert.equal(result.error, "LINEAR_RESOURCE_UNSUPPORTED");
    assert.equal(f.requests.filter((request) => request.mutation).length, 0);
    assert.equal(f.present.has(id), true);
  }
});

void test("an already trashed document is not deleted again", async () => {
  const f = fixture({ trashed: true });
  const result = await invoke(f, "delete_document");
  assert.equal(result.effect, "not-applied");
  assert.equal(result.error, "LINEAR_RESOURCE_UNSUPPORTED");
  assert.equal(f.requests.filter((request) => request.mutation).length, 0);
});
void test("preflight permission and quota refusals have no deletion effect", async () => {
  for (const operation of operations)
    for (const status of [401, 403, 429]) {
      const f = fixture({
        preflight: Response.json({ errors: [{ message: "Fixture refusal" }] }, { status }),
      });
      const result = await invoke(f, operation);
      assert.equal(result.effect, "not-applied");
      assert.equal(f.requests.filter((request) => request.mutation).length, 0);
      assert.equal(f.present.has(id), true);
    }
});

void test("uncertain, refused and malformed dispatched deletes are never replayed", async () => {
  for (const operation of operations)
    for (const mutate of [
      () => {
        throw Error("private-delete-fixture-token");
      },
      () => Response.json({ errors: [{ message: "Fixture permission refusal" }] }, { status: 403 }),
      () => Response.json({ errors: [{ message: "Fixture quota refusal" }] }, { status: 429 }),
      () => ({ deleted: { success: false, entityId: id } }),
      () => ({
        deleted: { success: true, entityId: otherId, entity: { id: otherId, trashed: true } },
      }),
      () => ({ deleted: { success: true } }),
      () => ({ deleted: null }),
      () =>
        Response.json({
          data: { deleted: { success: true, entityId: id } },
          errors: [{ message: "Fixture partial execution", path: ["deleted"] }],
        }),
    ]) {
      const f = fixture({ mutate });
      const result = await invoke(f, operation);
      assert.equal(result.effect, "unknown", operation);
      assert.equal(result.targetId, id);
      assert(result.error);
      assert.equal(f.requests.filter((request) => request.mutation).length, 1);
      assert(!JSON.stringify(result).includes("private-delete-fixture-token"));
    }
});

void test("authorization changes before and after delete dispatch retain the correct uncertainty", async () => {
  for (const operation of operations)
    for (const changeAfter of ["read", "mutation"] as const) {
      const f = fixture({ changeAfter });
      const result = await invoke(f, operation);
      assert.equal(result.effect, changeAfter === "read" ? "not-applied" : "unknown");
      assert.equal(result.error, "LINEAR_AUTH_CONTEXT_CHANGED");
      assert.equal(
        f.requests.filter((request) => request.mutation).length,
        changeAfter === "read" ? 0 : 1,
      );
    }
});

void test("a connection change while mutation authorization resolves prevents dispatch", async () => {
  for (const operation of operations) {
    const f = fixture({ changeOnAuthorization: operation === "delete_workflow_skill" ? 3 : 2 });
    const result = await invoke(f, operation);
    assert.equal(result.effect, "not-applied", operation);
    assert.equal(result.error, "LINEAR_AUTH_CONTEXT_CHANGED");
    assert.equal(f.requests.filter((request) => request.mutation).length, 0);
  }
});
void test("a successful document deletion retains its known effect when the optional entity is null", async () => {
  const f = fixture({ mutate: () => ({ deleted: { success: true, entity: null } }) });
  const result = await invoke(f, "delete_document");
  assert.equal(result.effect, "applied", result.error);
  assert.equal(result.targetId, id);
  assert.deepEqual(result.data, { id, workspace: "example", success: true });
  assert.equal(f.requests.filter((request) => request.mutation).length, 1);
});
void test("resource CLI routes fixed deletes to native transport without MCP schemas or credentials", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-native-delete-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "input.json");
  await writeFile(file, JSON.stringify({ id }));
  for (const operation of operations) {
    const f = fixture();
    const runtime: Runtime = {
      cwd: directory,
      env: {},
      stdout: process.stdout,
      mcpUrl: "https://fixture.invalid",
      client: {
        listTools: async () => {
          throw new Error("A native operation must not enumerate MCP schemas");
        },
        callTool: async () => {
          throw new Error("Native authorization must not use MCP credentials");
        },
      },
      searchClient: {
        searchObjects: unexpectedSearch,
        workflowCapabilities: () => f.client.capabilities(),
        invokeWorkflow: f.client.invoke.bind(f.client),
      },
    };
    const output = await run(
      ["resources", "invoke", operation, "--workspace", "example", "--input-file", file],
      runtime,
    );
    const result = decode(output) as {
      invocation: { operation: string; effect: string; targetId: string };
    };
    assert.equal(result.invocation.operation, operation);
    assert.equal(result.invocation.effect, "applied");
    assert.equal(result.invocation.targetId, id);
    assert.equal(f.requests.filter((request) => request.mutation).length, 1);
  }
});
