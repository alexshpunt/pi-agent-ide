/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import type { WorkflowOperation } from "#axi/native-workflow.ts";
import { isUnknownArray } from "#axi/types.ts";
import {
  fixtureGraphqlOperation,
  fixtureGraphqlRequest,
  type FixtureGraphqlRequest,
} from "./fixtures/graphql-request.ts";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";
import { run } from "#axi/cli.ts";
import { decode } from "@toon-format/toon-v4";
import type { Runtime } from "#axi/types.ts";

const teamId = "00000000-0000-4000-8000-000000000102";
const skillId = "00000000-0000-4000-8000-000000000103";
const templateId = "00000000-0000-4000-8000-000000000104";
const organization = { id: "00000000-0000-4000-8000-000000000105", urlKey: "example" };
const viewer = { organization };
const team = { id: teamId, organization };
const descriptionData = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Updated content" }] }],
};
function skill(id = skillId) {
  return {
    id,
    title: "Workflow",
    body: "Original body",
    teamId,
    shared: true,
    inheritedFrom: null,
    owner: { organization },
    icon: "book",
    color: "#123456",
  };
}
function template() {
  return {
    id: templateId,
    name: "Existing template",
    type: "document",
    description: "Existing help",
    content: "Old body",
    templateData: JSON.stringify({
      title: "Keep this placeholder",
      descriptionData: { type: "doc", content: [] },
      labels: ["existing-label"],
      stateId: "existing-state",
    }),
    organization,
    team: null,
    inheritedFrom: null,
    icon: "book",
    color: "#123456",
    sortOrder: 7,
  };
}
type Request = FixtureGraphqlRequest & { name: string; init: RequestInit };
function fixture(override?: (request: Request) => unknown) {
  const requests: Request[] = [];
  let currentSkill = skill();
  let currentTemplate = template();
  let authCalls = 0;
  const native = new LinearGraphqlClient({
    tokenProvider: {
      getToken: async () => {
        authCalls++;
        return "fixture";
      },
      clearCache: async () => {
        throw new Error("Unexpected auth replay");
      },
    },
    fetchImpl: async (_url, init) => {
      assert(init);
      const parsed = fixtureGraphqlRequest(init);
      const request: Request = { ...parsed, name: fixtureGraphqlOperation(parsed.query), init };
      requests.push(request);
      const forced = await override?.(request);
      if (forced instanceof Response) return forced;
      if (forced !== undefined) return new Response(JSON.stringify({ data: forced }));
      let data: unknown;
      switch (request.name) {
        case "WorkflowTeam": {
          data = { viewer, team };
          break;
        }
        case "WorkflowSkill": {
          data = { viewer, skill: currentSkill };
          break;
        }
        case "WorkflowSkillList": {
          data = {
            viewer,
            agentSkills: {
              nodes: [currentSkill],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
          break;
        }
        case "WorkflowTemplate": {
          data = { viewer, template: currentTemplate };
          break;
        }
        case "WorkflowSkillCreate": {
          currentSkill = { ...currentSkill, ...fixtureRecord(request.variables.input) };
          data = { saved: { success: true, agentSkill: currentSkill } };
          break;
        }
        case "WorkflowSkillUpdate": {
          currentSkill = { ...currentSkill, ...fixtureRecord(request.variables.input) };
          data = { saved: { success: true, agentSkill: currentSkill } };
          break;
        }
        case "WorkflowTemplateUpdate": {
          currentTemplate = { ...currentTemplate, ...fixtureRecord(request.variables.input) };
          data = { saved: { success: true, template: currentTemplate } };
          break;
        }
        default: {
          throw new Error(`Unexpected request ${request.name}`);
        }
      }
      return new Response(JSON.stringify({ data }));
    },
  });
  return { native, requests, authCalls: () => authCalls };
}
function invoke(native: LinearGraphqlClient, operation: WorkflowOperation, input: unknown) {
  return native.invokeWorkflow(operation, input, "example");
}

function recorded(requests: readonly Request[], name: string): Request {
  const request = requests.find((entry) => entry.name === name);
  assert(request, `Expected a recorded ${name} request`);
  return request;
}
function runtime(native?: LinearGraphqlClient, workspace = "example") {
  const calls: string[] = [];
  const value: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    searchClient: native,
    client: {
      listTools: async () => [
        {
          name: "get_template",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      ],
      callTool: async (name) => {
        calls.push(name);
        return {
          structuredContent:
            name === "get_workspace"
              ? { url: `https://linear.app/${workspace}` }
              : { id: "legacy" },
        };
      },
    },
  };
  return { value, calls };
}
async function command(t: test.TestContext, operation: string, input: unknown, value: Runtime) {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "input.json");
  await writeFile(file, JSON.stringify(input));
  return run(
    ["resources", "invoke", operation, "--workspace", "example", "--input-file", file],
    value,
  );
}

void test("an MCP-only connection reports unavailable native API instead of asking for another login", async (t) => {
  let dispatched = false;
  const native = new LinearGraphqlClient({
    tokenProvider: {
      getToken: async () => assert.fail("Expected a native authorization header"),
      clearCache: async () => assert.fail("Unexpected auth replay"),
      getAuthorization: async () => {
        throw new Error("LINEAR_AUTH_NATIVE_UNAVAILABLE");
      },
    },
    fetchImpl: async () => {
      dispatched = true;
      throw new Error("must not dispatch");
    },
  });
  const refused = await invoke(native, "get_workflow_template", { id: templateId });
  assert.equal(refused.effect, "not-applied");
  assert.equal(refused.error, "LINEAR_AUTH_NATIVE_UNAVAILABLE");
  const output = await command(
    t,
    "get_workflow_template",
    { id: templateId },
    runtime(native).value,
  );
  assert.match(output, /LINEAR_OPERATION_NATIVE_UNAVAILABLE/);
  assert.match(output, /native API/);
  assert.doesNotMatch(output, /LINEAR_OPERATION_AUTH_REQUIRED/);
  assert.equal(dispatched, false);
});
void test("native capabilities expose the fixed operations and keep legacy MCP reads", async () => {
  const { native } = fixture();
  const capabilities = native.workflowCapabilities();
  assert.deepEqual(capabilities.map((v) => v.name).sort(), [
    "create_workflow_template",
    "delete_document",
    "delete_workflow_skill",
    "delete_workflow_template",
    "get_workflow_skill",
    "get_workflow_template",
    "list_workflow_skills",
    "save_workflow_skill",
    "update_workflow_template",
  ]);
  for (const capability of capabilities)
    assert.equal(
      capability.annotations?.readOnlyHint,
      capability.name.startsWith("get_") || capability.name.startsWith("list_"),
    );
  const { value, calls } = runtime(native);
  const output = await run(["resources", "capabilities", "--workspace", "example"], value);
  for (const capability of capabilities) assert.match(output, new RegExp(capability.name));
  assert.match(output, /get_template/);
  assert.deepEqual(calls, ["get_workspace"]);
});

void test("native operations still require MCP workspace preflight and usable local schemas", async (t) => {
  const { native, requests } = fixture();
  const { value, calls } = runtime(native, "other");
  await assert.rejects(
    command(t, "save_workflow_skill", { teamId, title: "Title", body: "Body" }, value),
    /LINEAR_WORKSPACE_IDENTITY_MISMATCH/,
  );
  assert.deepEqual(calls, ["get_workspace"]);
  assert.deepEqual(requests, []);
  const valid = runtime(native);
  for (const input of [
    { teamId, title: "Title", body: "Body", shared: true },
    { teamId: "wrong", title: "Title", body: "Body" },
    { teamId, title: "Title" },
  ])
    await assert.rejects(
      command(t, "save_workflow_skill", input, valid.value),
      /LINEAR_INPUT_INVALID/,
    );
  assert.deepEqual(requests, []);
});

void test("native reads verify App viewer and target ownership, and preserve truthful template data", async () => {
  const { native, requests } = fixture();
  const read = await invoke(native, "get_workflow_skill", { id: skillId });
  assert.equal(read.effect, "applied");
  assert.equal(fixtureRecord(read.data).teamId, teamId);
  assert.equal(fixtureRecord(read.data).body, "Original body");
  const result = await invoke(native, "get_workflow_template", { id: templateId });
  assert.equal(result.effect, "applied");
  assert.equal(fixtureRecord(result.data).type, "document");
  assert.equal(fixtureRecord(result.data).scope, "workspace");
  assert.equal(fixtureRecord(result.data).templateData, template().templateData);
  assert.ok(requests.every((v) => !v.query.startsWith("mutation")));
  for (const field of ["viewer", "owner", "team", "template"] as const) {
    const wrong = fixture((r) => {
      if (field === "viewer")
        return {
          viewer: { organization: { ...organization, urlKey: "other" } },
          team,
          skill: skill(),
          template: template(),
        };
      if (field === "owner" && r.name === "WorkflowSkill")
        return {
          viewer,
          skill: { ...skill(), owner: { organization: { ...organization, urlKey: "other" } } },
        };
      if (field === "team" && r.name === "WorkflowTeam")
        return { viewer, team: { ...team, organization: { ...organization, urlKey: "other" } } };
      if (field === "template" && r.name === "WorkflowTemplate")
        return {
          viewer,
          template: { ...template(), organization: { ...organization, urlKey: "other" } },
        };
      return undefined;
    });
    const op = field === "template" ? "get_workflow_template" : "get_workflow_skill";
    const result = await invoke(wrong.native, op, {
      id: field === "template" ? templateId : skillId,
    });
    assert.equal(result.effect, "not-applied");
    assert.equal(result.error, "LINEAR_IDENTITY_MISMATCH");
  }
});

void test("skill lists use a verified team, bounded limit and honest next-page identity", async () => {
  const { native, requests } = fixture((r) =>
    r.name === "WorkflowSkillList"
      ? {
          viewer,
          agentSkills: {
            nodes: [skill()],
            pageInfo: { hasNextPage: true, endCursor: "actual-next" },
          },
        }
      : undefined,
  );
  const result = await invoke(native, "list_workflow_skills", {
    teamId,
    limit: 20,
    cursor: "existing-cursor",
  });
  assert.equal(result.effect, "applied");
  assert.equal(fixtureRecord(result.data).hasNextPage, true);
  assert.equal(fixtureRecord(result.data).cursor, "actual-next");
  const skills = fixtureRecord(result.data).skills;
  assert(isUnknownArray(skills));
  assert.equal(fixtureRecord(skills[0]).id, skillId);
  assert.deepEqual(recorded(requests, "WorkflowSkillList").variables, {
    teamId,
    first: 20,
    after: "existing-cursor",
  });
  for (const data of [
    { nodes: [skill()], pageInfo: { hasNextPage: true, endCursor: null } },
    {
      nodes: [{ ...skill(), teamId: templateId }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    { nodes: [skill(), skill()], pageInfo: { hasNextPage: false, endCursor: null } },
  ]) {
    const broken = fixture((r) =>
      r.name === "WorkflowSkillList" ? { viewer, agentSkills: data } : undefined,
    );
    const failed = await invoke(broken.native, "list_workflow_skills", { teamId });
    assert.equal(failed.effect, "not-applied");
    assert.equal(failed.data, null);
    assert.ok(failed.error);
  }
});

void test("new skill saves retain a generated correlation UUID and never send a made-up shared flag", async () => {
  const { native, requests } = fixture();
  const result = await invoke(native, "save_workflow_skill", {
    teamId,
    title: "Workflow title",
    body: "First line\nSecond line",
  });
  assert.equal(result.effect, "applied");
  assert(typeof result.targetId === "string");
  assert.match(result.targetId, /^[0-9a-f-]{36}$/);
  assert.equal(fixtureRecord(result.data).id, result.targetId);
  assert.equal(fixtureRecord(result.data).title, "Workflow title");
  const mutation = recorded(requests, "WorkflowSkillCreate");
  assert.deepEqual(mutation.variables.input, {
    id: result.targetId,
    teamId,
    title: "Workflow title",
    body: "First line\nSecond line",
  });
  assert.equal(mutation.init.redirect, "error");
});

void test("existing skills retain team and unrelated fields, and reject personal or inherited targets", async () => {
  const { native, requests } = fixture();
  const result = await invoke(native, "save_workflow_skill", {
    id: skillId,
    teamId,
    title: "Changed",
    body: "Changed body",
  });
  assert.equal(result.effect, "applied");
  assert.equal(fixtureRecord(result.data).icon, "book");
  assert.deepEqual(recorded(requests, "WorkflowSkillUpdate").variables, {
    id: skillId,
    input: { title: "Changed", body: "Changed body" },
  });
  for (const existing of [
    { ...skill(), teamId: null },
    { ...skill(), teamId: templateId },
    { ...skill(), inheritedFrom: { id: templateId } },
  ]) {
    const refused = fixture((r) =>
      r.name === "WorkflowSkill" ? { viewer, skill: existing } : undefined,
    );
    const failed = await invoke(refused.native, "save_workflow_skill", {
      id: skillId,
      teamId,
      title: "Changed",
      body: "Changed body",
    });
    assert.equal(failed.effect, "not-applied");
    assert.ok(failed.error);
    assert.ok(refused.requests.every((r) => !r.query.startsWith("mutation")));
  }
});

void test("template updates merge only descriptionData and optional help while preserving identity and defaults", async () => {
  const { native, requests } = fixture();
  const result = await invoke(native, "update_workflow_template", {
    id: templateId,
    descriptionData,
    description: "New help",
  });
  assert.equal(result.effect, "applied");
  assert.equal(fixtureRecord(result.data).id, templateId);
  assert.equal(fixtureRecord(result.data).type, "document");
  assert.equal(fixtureRecord(result.data).scope, "workspace");
  const update = recorded(requests, "WorkflowTemplateUpdate");
  assert.deepEqual(update.variables, {
    id: templateId,
    input: {
      templateData: JSON.stringify({ ...jsonRecord(template().templateData), descriptionData }),
      description: "New help",
    },
  });
  assert.equal(fixtureRecord(result.data).name, "Existing template");
  assert.equal(fixtureRecord(result.data).sortOrder, 7);
  const preserve = fixture();
  await invoke(preserve.native, "update_workflow_template", { id: templateId, descriptionData });
  assert.equal(
    Object.hasOwn(
      fixtureRecord(recorded(preserve.requests, "WorkflowTemplateUpdate").variables.input),
      "description",
    ),
    false,
  );
});

void test("template updates reject unsupported, inherited or malformed targets before mutation", async () => {
  for (const existing of [
    { ...template(), type: "project" },
    { ...template(), inheritedFrom: { id: skillId } },
    { ...template(), templateData: "not-json" },
    { ...template(), templateData: "[]" },
    { ...template(), team: { ...team, organization: { ...organization, urlKey: "other" } } },
  ]) {
    const refused = fixture((r) =>
      r.name === "WorkflowTemplate" ? { viewer, template: existing } : undefined,
    );
    const result = await invoke(refused.native, "update_workflow_template", {
      id: templateId,
      descriptionData,
    });
    assert.equal(result.effect, "not-applied");
    assert.ok(result.error);
    assert.ok(refused.requests.every((r) => !r.query.startsWith("mutation")));
  }
});

void test("invalid native inputs are rejected before authentication and invalid documents cannot reach Linear", async () => {
  const { native, requests, authCalls } = fixture();
  for (const [operation, input] of [
    ["get_workflow_skill", { id: "not-a-uuid" }],
    ["list_workflow_skills", { teamId, limit: 51 }],
    ["list_workflow_skills", { teamId, limit: 0 }],
    ["save_workflow_skill", { teamId, title: " ", body: "Body" }],
    ["save_workflow_skill", { teamId, title: "Title", body: "Body", shared: true }],
    [
      "update_workflow_template",
      { id: templateId, descriptionData: { type: "paragraph", content: [] } },
    ],
    [
      "update_workflow_template",
      { id: templateId, descriptionData: { type: "doc", content: [{ text: "No node type" }] } },
    ],
    ["update_workflow_template", { id: templateId, descriptionData, teamId }],
    // Exercise the runtime guard for a caller that bypasses the TypeScript contract.
    ["templateCreate" as WorkflowOperation, { title: "Forbidden" }],
  ] as const) {
    const result = await invoke(native, operation, input);
    assert.equal(result.effect, "not-applied");
    assert.ok(result.error);
  }
  assert.equal(authCalls(), 0);
  assert.deepEqual(requests, []);
});

void test("preflight failures are not applied, mutation loss is unknown, sanitized and never replayed", async () => {
  for (const [status, error] of [
    [401, "LINEAR_GRAPHQL_AUTH_REQUIRED"],
    [403, "LINEAR_PERMISSION_DENIED"],
    [429, "LINEAR_RATE_LIMITED"],
    [500, "LINEAR_GRAPHQL_FAILED"],
  ] as const) {
    for (const duringMutation of [false, true]) {
      const refused = fixture((r) => {
        if (!duringMutation || r.query.startsWith("mutation"))
          return new Response("private bearer-value", { status });
        return undefined;
      });
      const result = await invoke(refused.native, "save_workflow_skill", {
        teamId,
        title: "Title",
        body: "Body",
      });
      assert.equal(result.effect, duringMutation ? "unknown" : "not-applied");
      assert.equal(result.error, error);
      assert(typeof result.targetId === "string");
      assert.match(result.targetId, /^[0-9a-f-]{36}$/);
      assert.doesNotMatch(JSON.stringify(result), /bearer-value/);
      assert.equal(
        refused.requests.filter((r) => r.query.startsWith("mutation")).length,
        duringMutation ? 1 : 0,
      );
    }
  }
  const lost = fixture((r) => {
    if (r.query.startsWith("mutation")) throw new Error("private bearer-value");
  });
  const result = await invoke(lost.native, "save_workflow_skill", {
    teamId,
    title: "Title",
    body: "Body",
  });
  assert.equal(result.effect, "unknown");
  assert(typeof result.targetId === "string");
  assert.match(result.targetId, /^[0-9a-f-]{36}$/);
  assert.equal(lost.requests.filter((r) => r.query.startsWith("mutation")).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /bearer-value/);
});

void test("false success, wrong identity and ignored saved content remain unknown with their target identity", async () => {
  for (const saved of [
    { success: false, agentSkill: skill() },
    { success: true, agentSkill: skill() },
    { success: true, agentSkill: { ...skill(), id: skillId, body: "Original body" } },
  ]) {
    const broken = fixture((r) => (r.query.startsWith("mutation") ? { saved } : undefined));
    const result = await invoke(broken.native, "save_workflow_skill", {
      teamId,
      title: "Title",
      body: "New",
    });
    assert.equal(result.effect, "unknown");
    assert.ok(result.targetId);
    assert.ok(result.error);
  }
  const ignored = fixture((r) =>
    r.name === "WorkflowTemplateUpdate"
      ? { saved: { success: true, template: template() } }
      : undefined,
  );
  const result = await invoke(ignored.native, "update_workflow_template", {
    id: templateId,
    descriptionData,
  });
  assert.equal(result.effect, "unknown");
  assert.equal(result.targetId, templateId);
});

void test("native operation names cannot be supplied or reclassified by MCP", async (t) => {
  const { native, requests } = fixture();
  for (const client of [undefined, native]) {
    const { value, calls } = runtime(client);
    value.client.listTools = async () => [
      {
        name: "save_workflow_skill",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ];
    if (!client) {
      const capabilities = await run(
        ["resources", "capabilities", "--workspace", "example"],
        value,
      );
      assert.doesNotMatch(capabilities, /save_workflow_skill/);
      await assert.rejects(
        command(t, "save_workflow_skill", {}, value),
        /LINEAR_RESOURCE_UNSUPPORTED/,
      );
    } else {
      await assert.rejects(command(t, "save_workflow_skill", {}, value), /LINEAR_INPUT_INVALID/);
      const output = await command(
        t,
        "save_workflow_skill",
        { teamId, title: "Title", body: "Body" },
        value,
      );
      assert.match(output, /effect: applied/);
    }
    assert.ok(calls.every((name) => name === "get_workspace"));
  }
  assert.equal(requests.filter((r) => r.query.startsWith("mutation")).length, 1);
});

void test("cancelled native requests do not authenticate or dispatch, and malformed acknowledgements stay unknown", async () => {
  const cancelled = fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await cancelled.native.invokeWorkflow(
    "save_workflow_skill",
    { teamId, title: "Title", body: "Body" },
    "example",
    controller.signal,
  );
  assert.equal(result.effect, "not-applied");
  assert.ok(result.targetId);
  assert.equal(cancelled.authCalls(), 0);
  assert.deepEqual(cancelled.requests, []);
  for (const response of [
    new Response("not-json"),
    new Response(JSON.stringify({ data: null })),
    new Response(
      JSON.stringify({
        errors: [{ message: "private detail", extensions: { code: "FORBIDDEN" } }],
      }),
    ),
  ]) {
    const broken = fixture((r) => (r.query.startsWith("mutation") ? response : undefined));
    const failed = await invoke(broken.native, "save_workflow_skill", {
      teamId,
      title: "Title",
      body: "Body",
    });
    assert.equal(failed.effect, "unknown");
    assert.ok(failed.targetId);
    assert.ok(failed.error);
    assert.doesNotMatch(JSON.stringify(failed), /private detail/);
    assert.equal(broken.requests.filter((r) => r.query.startsWith("mutation")).length, 1);
  }
});

void test("existing skill saves never confirm ignored content or changed unrelated fields", async () => {
  for (const changed of [
    skill(),
    { ...skill(), title: "Changed", body: "Changed body", icon: "changed" },
    { ...skill(), title: "Changed", body: "Changed body", teamId: templateId },
  ]) {
    const broken = fixture((r) =>
      r.name === "WorkflowSkillUpdate"
        ? { saved: { success: true, agentSkill: changed } }
        : undefined,
    );
    const result = await invoke(broken.native, "save_workflow_skill", {
      id: skillId,
      teamId,
      title: "Changed",
      body: "Changed body",
    });
    assert.equal(result.effect, "unknown");
    assert.equal(result.targetId, skillId);
    assert.ok(result.error);
  }
});
void test("CLI receipts retain unknown create identity and do not dispatch native operation names to MCP", async (t) => {
  const lost = fixture((r) => {
    if (r.query.startsWith("mutation")) throw new Error("private response");
  });
  const { value, calls } = runtime(lost.native);
  const output = await command(
    t,
    "save_workflow_skill",
    { teamId, title: "Title", body: "Body" },
    value,
  );
  assert.match(output, /effect: unknown/);
  assert.match(output, /targetId: [0-9a-f-]{36}/);
  assert.doesNotMatch(output, /private response/);
  assert.deepEqual(calls, ["get_workspace"]);
  const absent = runtime();
  await assert.rejects(
    command(t, "save_workflow_skill", { teamId, title: "Title", body: "Body" }, absent.value),
    /LINEAR_RESOURCE_UNSUPPORTED/,
  );
  assert.deepEqual(absent.calls, ["get_workspace"]);
});

void test("each existing skill update verifies its team once and keeps a fresh target read", async (t) => {
  const { native, requests } = fixture();
  for (const body of ["First edit", "Second edit"]) {
    const output = await command(
      t,
      "save_workflow_skill",
      {
        id: skillId,
        teamId,
        title: "Changed",
        body,
      },
      runtime(native).value,
    );
    const { invocation } = decode(output) as {
      invocation: { effect: string; data: string };
    };
    assert.equal(invocation.effect, "applied");
    assert.equal(jsonRecord(invocation.data).body, body);
  }
  assert.deepEqual(
    requests.map((r) => r.name),
    [
      "WorkflowTeam",
      "WorkflowSkill",
      "WorkflowSkillUpdate",
      "WorkflowTeam",
      "WorkflowSkill",
      "WorkflowSkillUpdate",
    ],
  );
});

void test("a reused team proof cannot authorize another team or organization", async (t) => {
  const otherOrganization = { ...organization, id: templateId };
  for (const target of [
    { viewer, skill: { ...skill(), teamId: templateId } },
    { viewer, skill: { ...skill(), teamId: null } },
    { viewer, skill: { ...skill(), inheritedFrom: { id: templateId } } },
    { viewer, skill: { ...skill(), owner: { organization: otherOrganization } } },
    { viewer: { organization: otherOrganization }, skill: skill() },
  ]) {
    const { native, requests } = fixture((request) =>
      request.name === "WorkflowSkill" ? target : undefined,
    );
    const output = await command(
      t,
      "save_workflow_skill",
      {
        id: skillId,
        teamId,
        title: "Changed",
        body: "Changed body",
      },
      runtime(native).value,
    );
    const { invocation } = decode(output) as {
      invocation: { effect: string; error: string };
    };
    assert.equal(invocation.effect, "not-applied");
    assert.equal(invocation.error, "LINEAR_OPERATION_IDENTITY_MISMATCH");
    assert.ok(requests.every((r) => !r.query.startsWith("mutation")));
  }
});
