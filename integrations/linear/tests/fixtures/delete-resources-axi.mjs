import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { run } from "#linear-axi/src/cli.ts";
import { NativeWorkflowClient } from "#linear-axi/src/native-workflow.ts";
import { deleteIds, deleteOrganization, deleteTeamId } from "./delete-resources-state.ts";

const args = process.argv.slice(2);
const file = "delete-fixture.json";
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (state) => writeFileSync(file, JSON.stringify(state, null, 2));
if (args[0] === "auth" && args[1] === "epoch") {
  console.log(JSON.stringify({ epoch: "legacy", state: "legacy" }));
  process.exit(0);
}
appendFileSync("delete-axi-calls.jsonl", JSON.stringify(args) + "\n");
const client = new NativeWorkflowClient({
  tokenProvider: {
    getAuthorization: async () => "Bearer private-delete-fixture-token",
    assertCurrentAuthorization: async () => {},
  },
  fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://api.linear.app/graphql");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer private-delete-fixture-token",
    );
    assert.equal(init.redirect, "error");
    const body = JSON.parse(String(init.body));
    const state = load();
    state.requests.push(body);
    save(state);
    const viewer = { organization: deleteOrganization };
    const reply = (data) => {
      save(state);
      return Response.json({ data: { viewer, ...data } });
    };
    const mutation = body.query.match(
      /\b(?:(\w+)\s*:\s*)?(agentSkillDelete|templateDelete|documentDelete)\s*\(/u,
    );
    if (mutation) {
      const id = body.variables.id;
      const resource = state.resources[id];
      assert(
        resource && !resource.deleted && !resource.trashed,
        "A missing or replayed target reached mutation dispatch",
      );
      assert(
        ![deleteIds.refused, deleteIds.cancelled, deleteIds.preserved, deleteIds.foreign].includes(
          id,
        ),
        "A protected target reached mutation dispatch",
      );
      state.mutations.push({ field: mutation[2], id });
      if (mutation[2] === "documentDelete") {
        resource.trashed = true;
        resource.archivedAt = "2026-01-01T00:00:00.000Z";
      } else resource.deleted = true;
      save(state);
      if (id === deleteIds.unknown)
        throw new Error("Controlled response loss after saved deletion");
      // DocumentArchivePayload permits a null entity after an acknowledged deletion.
      const payload =
        mutation[2] === "documentDelete"
          ? { success: true, entity: null }
          : { success: true, entityId: id };
      return reply({ [mutation[1] ?? mutation[2]]: payload });
    }
    const resource = state.resources[body.variables.id];
    const existing = resource && !resource.deleted && !resource.trashed ? resource : null;
    if (/\bagentSkill\s*\(/u.test(body.query))
      return reply({ skill: existing, agentSkill: existing });
    if (/\btemplate\s*\(/u.test(body.query)) return reply({ template: existing });
    if (/\bdocument\s*\(/u.test(body.query)) return reply({ document: existing });
    if (/\bteam\s*\(/u.test(body.query)) {
      assert.equal(body.variables.id, deleteTeamId);
      return reply({ team: { id: deleteTeamId, organization: deleteOrganization } });
    }
    if (/\bviewer\b/u.test(body.query)) return reply({});
    throw new Error("Unexpected native fixture query");
  },
});
assert.equal(args[0], "resources");
const metadataCapabilities = ["get_document", "save_document"].map((name) => ({
  name,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: name === "get_document" },
}));
const runtime = {
  cwd: process.cwd(),
  env: {},
  stdout: process.stdout,
  mcpUrl: "https://fixture.invalid",
  client: {
    listTools: async () => metadataCapabilities,
    callTool: async (name) => {
      assert.equal(name, "get_workspace", "Metadata-only MCP operations must not dispatch");
      return { structuredContent: { url: "https://linear.app/example" } };
    },
  },
  searchClient: {
    workflowCapabilities: () => client.capabilities(),
    invokeWorkflow: async (operation, input, workspace) => {
      const state = load();
      state.invokes.push({ workspace, operation, input });
      save(state);
      return client.invoke(operation, input, workspace);
    },
  },
};
// Use the production dispatcher, including its public error-envelope normalization.
console.log(await run(args, runtime));
