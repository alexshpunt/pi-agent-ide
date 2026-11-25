import { expect, test, vi } from "vitest";
import { createLinearFields } from "#linear/fields.ts";
import { readLinearDomain } from "#linear/domain-read.ts";
import type {
  LinearOperationBackend,
  LinearOperationCapability,
  LinearOperationReceipt,
} from "#linear/operation-backend.ts";

const id = "cc4a56e3-8306-4f29-a859-bbc94618630c";
const teamId = "bd884dfe-27ec-47f0-83d8-61f620e05091";
const descriptionData = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Updated body" }] }],
};
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected fixture object");
  return value as Record<string, unknown>;
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  return record(value);
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected fixture list");
  return value;
}

function sourceOf(value: Record<string, unknown>): string {
  if (typeof value.source !== "string") throw new Error("Expected fixture source");
  return value.source;
}

const capabilities: LinearOperationCapability[] = [
  {
    name: "get_workflow_skill",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: {},
  },
  {
    name: "list_workflow_skills",
    inputSchema: schema(
      {
        teamId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
      },
      ["teamId"],
    ),
    annotations: {},
  },
  {
    name: "save_workflow_skill",
    inputSchema: schema(
      {
        id: { type: "string" },
        teamId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      ["teamId", "title", "body"],
    ),
    annotations: {},
  },
  {
    name: "get_workflow_template",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: {},
  },
  {
    name: "update_workflow_template",
    inputSchema: schema(
      {
        id: { type: "string" },
        descriptionData: { type: "object" },
        description: { type: "string" },
      },
      ["id"],
    ),
    annotations: {},
  },
];
test("advertised template write fields can be submitted without a forbidden identity", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  const contract = parseObject(
    await fields.read(`linear://example/workflow-template/${id}#schema`, process.cwd()),
  );
  const action = record(list(contract.actions)[0]);
  for (const input of [record(contract.fields), record(action.input)]) {
    expect(input.properties).not.toHaveProperty("id");
    expect(input.required).not.toContain("id");
    expect(input.additionalProperties).toBe(false);
    expect(record(input.properties).descriptionData).toEqual({ type: "object" });
  }
  expect(record(record(contract.read).input).required).toEqual(["id"]);
  expect(
    capabilities.find((item) => item.name === "update_workflow_template")?.inputSchema.required,
  ).toEqual(["id"]);
  await fields.write(sourceOf(action), JSON.stringify({ descriptionData }), process.cwd());
  expect(
    f.invoke.mock.calls.find(([, operation]) => operation === "update_workflow_template")?.[2],
  ).toEqual({ id, descriptionData });
});

test("native skill creation schemas omit identity but retain required managed fields", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  const direct = parseObject(
    await fields.read("linear://example/workflow-skill/new", process.cwd()),
  );
  const contract = parseObject(
    await fields.read(`linear://example/workflow-skill/${id}#schema`, process.cwd()),
  );
  for (const input of [record(direct.input), record(record(contract.creation).input)]) {
    expect(input.properties).not.toHaveProperty("id");
    expect(input.required).toEqual(["teamId", "title", "body"]);
  }
  await fields.write(
    sourceOf(direct),
    JSON.stringify({ teamId, title: "Example", body: "Created" }),
    process.cwd(),
  );
  expect(f.skill().body).toBe("Created");
  f.invoke.mockClear();
  await expect(
    fields.write(
      sourceOf(direct),
      JSON.stringify({ id, teamId, title: "Example", body: "Override" }),
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_OVERRIDE", effect: "not-applied" });
  expect(f.invoke).not.toHaveBeenCalled();
});
test("action schemas keep payload constraints while the URL supplies non-id identities", async () => {
  const inputSchema = schema({ threadId: { type: "string" }, resolved: { type: "boolean" } }, [
    "threadId",
    "resolved",
  ]);
  const f = fixture();
  f.backend.capabilities = async () => [
    { name: "resolve_diff_thread", inputSchema, annotations: {} },
  ];
  const permit = vi.fn();
  const fields = createLinearFields(f.backend, permit);
  const contract = parseObject(
    await fields.read(`linear://example/diff-thread/${id}#resolve`, process.cwd()),
  );
  const action = record(list(contract.actions)[0]);
  const input = record(action.input);
  expect(input.properties).toEqual({ resolved: { type: "boolean" } });
  expect(input.required).toEqual(["resolved"]);
  expect(inputSchema.required).toEqual(["threadId", "resolved"]);
  await fields.write(sourceOf(action), JSON.stringify({ resolved: true }), process.cwd());
  expect(f.invoke.mock.calls[0]?.[2]).toEqual({ threadId: id, resolved: true });
  expect(permit).toHaveBeenCalledOnce();
});
function fixture() {
  let skill = { id, teamId, title: "Example", body: "Before" };
  let template = {
    id,
    name: "Existing",
    type: "document",
    teamId: null,
    description: "Help",
    templateData: JSON.stringify({
      title: "Preserved placeholder",
      descriptionData: { type: "doc", content: [] },
    }),
  };
  const invoke = vi.fn(
    async (
      workspace: string,
      operation: string,
      input: Record<string, unknown>,
    ): Promise<LinearOperationReceipt> => {
      if (operation === "save_workflow_skill") {
        if (!input.teamId || !input.title || !input.body)
          return {
            workspace,
            operation,
            effect: "not-applied",
            error: "LINEAR_INVALID_OPERATION_INPUT",
          };
        skill = { ...skill, ...input };
      }
      if (operation === "update_workflow_template")
        template = {
          ...template,
          description:
            typeof input.description === "string" ? input.description : template.description,
          templateData: JSON.stringify({
            ...parseObject(template.templateData),
            descriptionData: input.descriptionData,
          }),
        };
      const data =
        operation === "list_workflow_skills"
          ? { agentSkills: [skill], hasNextPage: true, cursor: "next/page" }
          : operation.includes("template")
            ? { ...template }
            : { ...skill };
      return { workspace, operation, effect: "applied", data };
    },
  );
  const backend: LinearOperationBackend = { capabilities: async () => capabilities, invoke };
  return { backend, invoke, skill: () => skill, template: () => template };
}

test("native workflow lists retain team scope and exact continuation identity", async () => {
  const f = fixture();
  const result = await readLinearDomain(
    `linear://example/workflow-skills?teamId=${teamId}&limit=2`,
    process.cwd(),
    undefined,
    f.backend,
  );
  expect(result).toContain(`linear://example/workflow-skill/${id}`);
  expect(result).toContain(`teamId=${teamId}&limit=2&cursor=next%2Fpage`);
  expect(f.invoke.mock.calls[0]).toEqual([
    "example",
    "list_workflow_skills",
    { teamId, limit: 2 },
    process.cwd(),
    undefined,
  ]);
  await expect(
    readLinearDomain("linear://example/workflow-skills", process.cwd(), undefined, f.backend),
  ).rejects.toMatchObject({ effect: "not-applied" });
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("native skill creation and later body edits use the same resource", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  await fields.write(
    "linear://example/workflow-skill/new",
    JSON.stringify({ title: "Example", body: "Created", teamId }),
    process.cwd(),
  );
  expect(f.skill()).toMatchObject({ id, teamId, body: "Created" });
  await fields.write(`linear://example/workflow-skill/${id}#body`, "Updated", process.cwd());
  expect(await fields.read(`linear://example/workflow-skill/${id}#body`, process.cwd())).toBe(
    "Updated",
  );
  expect(f.skill()).toMatchObject({ id, teamId, title: "Example" });
  expect(
    f.invoke.mock.calls.filter(([, operation]) => operation === "save_workflow_skill"),
  ).toHaveLength(2);
});

test("template synchronization writes only managed body and help fields", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  await fields.write(
    `linear://example/workflow-template/${id}#fields`,
    JSON.stringify({ descriptionData, description: "Updated help" }),
    process.cwd(),
  );
  expect(f.template()).toMatchObject({
    id,
    name: "Existing",
    type: "document",
    teamId: null,
    description: "Updated help",
  });
  expect(JSON.parse(f.template().templateData)).toEqual({
    title: "Preserved placeholder",
    descriptionData,
  });
  expect(
    JSON.parse(
      await fields.read(`linear://example/workflow-template/${id}#descriptionData`, process.cwd()),
    ),
  ).toEqual(descriptionData);
  expect(
    f.invoke.mock.calls.find(([, operation]) => operation === "update_workflow_template")?.[2],
  ).toEqual({ id, descriptionData, description: "Updated help" });
  const contract = parseObject(
    await fields.read(`linear://example/workflow-template/${id}#schema`, process.cwd()),
  );
  expect(contract).not.toHaveProperty("creation");
});

test("an update-only template route refuses a fabricated creation before dispatch", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  for (const action of [
    () => fields.read("linear://example/workflow-template/new", process.cwd()),
    () =>
      fields.write(
        "linear://example/workflow-template/new",
        JSON.stringify({ descriptionData }),
        process.cwd(),
      ),
  ])
    await expect(action()).rejects.toMatchObject({
      code: "LINEAR_CREATION_UNSUPPORTED",
      effect: "not-applied",
    });
  expect(f.invoke).not.toHaveBeenCalled();
});

test("uncertain native skill writes remain unknown and are never replayed", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  f.backend.invoke = vi.fn(
    async (
      ...args: Parameters<LinearOperationBackend["invoke"]>
    ): Promise<LinearOperationReceipt> =>
      args[1] === "save_workflow_skill"
        ? {
            workspace: args[0],
            operation: args[1],
            effect: "unknown",
            error: "LINEAR_NATIVE_WRITE_UNKNOWN",
          }
        : original(...args),
  );
  await expect(
    createLinearFields(f.backend).write(
      `linear://example/workflow-skill/${id}#body`,
      "Changed",
      process.cwd(),
    ),
  ).rejects.toMatchObject({ effect: "unknown" });
  expect(
    vi
      .mocked(f.backend.invoke)
      .mock.calls.filter(([, operation]) => operation === "save_workflow_skill"),
  ).toHaveLength(1);
  expect(f.skill().body).toBe("Before");
});

test("an uncertain native creation retains its correlation resource for recovery", async () => {
  const f = fixture();
  f.backend.invoke = vi.fn(
    async (workspace: string, operation: string): Promise<LinearOperationReceipt> => ({
      workspace,
      operation,
      effect: "unknown",
      error: "LINEAR_NATIVE_WRITE_UNKNOWN",
      targetId: id,
    }),
  );
  await expect(
    createLinearFields(f.backend).write(
      "linear://example/workflow-skill/new",
      JSON.stringify({ teamId, title: "Example", body: "Body" }),
      process.cwd(),
    ),
  ).rejects.toMatchObject({ source: `linear://example/workflow-skill/${id}`, effect: "unknown" });
  expect(f.backend.invoke).toHaveBeenCalledTimes(1);
});
