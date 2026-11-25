import test from "node:test";
import assert from "node:assert/strict";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import {
  fixtureGraphqlOperation,
  fixtureGraphqlRequest,
  type FixtureGraphqlRequest,
} from "./fixtures/graphql-request.ts";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";

const organization = { id: "00000000-0000-4000-8000-000000000105", urlKey: "example" };
const teamId = "00000000-0000-4000-8000-000000000102";
const descriptionData = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Fixture body" }] }],
};
const input = {
  name: "ENG-751 disposable template",
  type: "issue",
  descriptionData,
  title: "ENG-751 disposable issue",
  description: "Disposable verification fixture",
  priority: 3,
};
type Request = FixtureGraphqlRequest & { name: string };
function fixture(override?: (request: Request) => unknown) {
  const requests: Request[] = [];
  let template: Record<string, unknown> | undefined;
  let authCalls = 0;
  const client = new LinearGraphqlClient({
    tokenProvider: {
      getToken: async () => {
        authCalls++;
        return "fixture";
      },
      clearCache: async () => {
        throw Error("No authentication replay");
      },
    },
    fetchImpl: async (_url, init) => {
      const parsed = fixtureGraphqlRequest(init);
      const request = { ...parsed, name: fixtureGraphqlOperation(parsed.query) };
      requests.push(request);
      const forced = override?.(request);
      if (forced instanceof Response) return forced;
      if (forced !== undefined) return new Response(JSON.stringify({ data: forced }));
      let data: Record<string, unknown>;
      switch (request.name) {
        case "WorkflowTemplateScope": {
          data = { viewer: { organization } };
          break;
        }
        case "WorkflowTeam": {
          data = { viewer: { organization }, team: { id: teamId, organization } };
          break;
        }
        case "WorkflowTemplateCreate": {
          const fields = fixtureRecord(request.variables.input);
          template = {
            ...fields,
            organization,
            team: fields.teamId ? { id: teamId, organization } : null,
            inheritedFrom: null,
            content: "Fixture body",
            icon: null,
            color: null,
            sortOrder: 0,
          };
          data = { saved: { success: true, template } };
          break;
        }
        case "WorkflowTemplate": {
          data = { viewer: { organization }, template };
          break;
        }
        case "WorkflowTemplateUpdate": {
          template = { ...template, ...fixtureRecord(request.variables.input) };
          data = { saved: { success: true, template } };
          break;
        }
        default: {
          throw Error(`Unexpected operation ${request.name}`);
        }
      }
      return new Response(JSON.stringify({ data }));
    },
  });
  return { client, requests, authCalls: () => authCalls, template: () => template };
}
const create = (f: ReturnType<typeof fixture>, value: Record<string, unknown> = input) =>
  f.client.invokeWorkflow("create_workflow_template", value, "example");

void test("template creation advertises a bounded schema without caller-owned identity", () => {
  const { client } = fixture();
  const capability = client
    .workflowCapabilities()
    .find(({ name }) => name === "create_workflow_template");
  assert(capability);
  assert(capability.annotations);
  assert.equal(capability.annotations.readOnlyHint, false);
  assert.equal(capability.annotations.idempotentHint, false);
  assert.deepEqual(capability.inputSchema.required, ["name", "type", "descriptionData"]);
  assert.equal(fixtureRecord(capability.inputSchema.properties).id, undefined);
});
for (const type of ["issue", "document"])
  for (const scoped of [false, true]) {
    void test(`creates a native ${type} template in ${scoped ? "team" : "workspace"} scope and keeps its identity on edit`, async () => {
      const f = fixture();
      const { priority: _priority, ...common } = input;
      const value = {
        ...common,
        type,
        ...(type === "issue" ? { priority: 3 } : {}),
        ...(scoped ? { teamId } : {}),
      };
      const created = await create(f, value);
      assert.equal(created.effect, "applied");
      assert(typeof created.targetId === "string");
      assert.match(created.targetId, /^[0-9a-f-]{36}$/u);
      const saved = fixtureRecord(created.data);
      assert.equal(saved.id, created.targetId);
      assert.equal(saved.name, value.name);
      assert.equal(saved.type, type);
      assert.equal(saved.teamId, scoped ? teamId : null);
      const request = f.requests.find(({ name }) => name === "WorkflowTemplateCreate");
      assert(request);
      const fields = fixtureRecord(request.variables.input);
      assert.deepEqual(jsonRecord(fields.templateData), {
        title: value.title,
        descriptionData,
        ...(type === "issue" ? { priority: 3 } : {}),
      });
      assert.equal(fields.id, created.targetId);
      assert.equal(fields.type, type);
      const edited = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Updated fixture body" }] }],
      };
      const updated = await f.client.invokeWorkflow(
        "update_workflow_template",
        { id: saved.id, descriptionData: edited },
        "example",
      );
      assert.equal(updated.effect, "applied");
      const savedUpdate = fixtureRecord(updated.data);
      assert.equal(savedUpdate.id, saved.id);
      assert.deepEqual(jsonRecord(savedUpdate.templateData), {
        title: value.title,
        descriptionData: edited,
        ...(type === "issue" ? { priority: 3 } : {}),
      });
      assert.equal(savedUpdate.name, value.name);
    });
  }
void test("invalid template inputs fail before authorization or HTTP", async () => {
  for (const patch of [
    { type: "project" },
    { type: "document", priority: 3 },
    { name: " " },
    { name: "x".repeat(257) },
    { descriptionData: { type: "doc", content: [{ type: "text", text: 123 }] } },
    { teamId: "ENG" },
    { priority: 5 },
    { id: teamId },
    { endpoint: "https://example.org" },
  ]) {
    const f = fixture();
    const result = await create(f, { ...input, ...patch });
    assert.equal(result.effect, "not-applied");
    assert.equal(result.error, "LINEAR_INPUT_INVALID");
    assert.deepEqual(f.requests, []);
    assert.equal(f.authCalls(), 0);
  }
});
void test("a foreign scope refuses creation before mutation", async () => {
  const f = fixture(({ name }) =>
    name === "WorkflowTeam"
      ? {
          viewer: { organization },
          team: { id: teamId, organization: { ...organization, urlKey: "other" } },
        }
      : undefined,
  );
  const result = await create(f, { ...input, teamId });
  assert.equal(result.effect, "not-applied");
  assert.equal(result.error, "LINEAR_IDENTITY_MISMATCH");
  assert.equal(f.requests.filter(({ name }) => name === "WorkflowTemplateCreate").length, 0);
});
void test("a refused or uncertain native creation keeps its generated UUID and is never replayed", async () => {
  for (const status of [403, 500]) {
    const f = fixture(({ name }) =>
      name === "WorkflowTemplateCreate" ? new Response("Fixture refusal", { status }) : undefined,
    );
    const result = await create(f);
    assert.equal(result.effect, "unknown");
    assert.equal(
      result.error,
      status === 403 ? "LINEAR_PERMISSION_DENIED" : "LINEAR_GRAPHQL_FAILED",
    );
    assert(typeof result.targetId === "string");
    assert.match(result.targetId, /^[0-9a-f-]{36}$/u);
    const requests = f.requests.filter(({ name }) => name === "WorkflowTemplateCreate");
    assert.equal(requests.length, 1);
    assert.equal(fixtureRecord(requests[0].variables.input).id, result.targetId);
    assert.equal(f.authCalls(), 2);
  }
});
void test("a saved template cannot claim success for another identity or content", async () => {
  for (const patch of [
    { id: teamId },
    { name: "Unexpected" },
    { type: "document" },
    { team: { id: teamId, organization } },
    {
      templateData: JSON.stringify({
        title: input.title,
        descriptionData: { type: "doc", content: [] },
        priority: 3,
      }),
    },
  ]) {
    const f = fixture(({ name, variables }) =>
      name === "WorkflowTemplateCreate"
        ? {
            saved: {
              success: true,
              template: {
                ...fixtureRecord(variables.input),
                organization,
                team: null,
                inheritedFrom: null,
                content: "Fixture body",
                ...patch,
              },
            },
          }
        : undefined,
    );
    const result = await create(f);
    assert.equal(result.effect, "unknown");
    assert.notEqual(result.error, undefined);
    assert(typeof result.targetId === "string");
    assert.match(result.targetId, /^[0-9a-f-]{36}$/u);
    assert.equal(f.requests.filter(({ name }) => name === "WorkflowTemplateCreate").length, 1);
  }
});
