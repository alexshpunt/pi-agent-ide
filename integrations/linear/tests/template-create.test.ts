import { expect, test, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { createLinearFields } from "#linear/fields.ts";
import {
  connectLinearOperationReceipts,
  createLinearOperationHandlers,
} from "#linear/operation-actions.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";
const id = "71000000-0000-4000-8000-000000000004";
const body = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Fixture" }] }],
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

function fixture() {
  let template = {
    id,
    name: "Existing template",
    type: "document",
    description: "Help",
    templateData: JSON.stringify({ title: "Placeholder", descriptionData: body }),
  };
  const invoke = vi.fn<LinearOperationBackend["invoke"]>(async (workspace, operation, input) => {
    if (operation === "create_workflow_template")
      template = {
        ...template,
        ...input,
        id,
        templateData: JSON.stringify({ descriptionData: input.descriptionData }),
      };
    if (operation === "update_workflow_template")
      template = {
        ...template,
        templateData: JSON.stringify({
          title: "Placeholder",
          descriptionData: input.descriptionData,
        }),
      };
    return { workspace, operation, effect: "applied" as const, data: template, targetId: id };
  });
  const backend: LinearOperationBackend = {
    capabilities: async () => [
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
          ["id", "descriptionData"],
        ),
        annotations: {},
      },
      {
        name: "create_workflow_template",
        inputSchema: schema(
          {
            name: { type: "string" },
            type: { enum: ["issue", "document"] },
            descriptionData: { type: "object" },
          },
          ["name", "type", "descriptionData"],
        ),
        annotations: {},
      },
    ],
    invoke,
  };
  return { fields: createLinearFields(backend), invoke, backend };
}
test("native template creation has its own usable schema while existing fields retain the update contract", async () => {
  const f = fixture();
  const source = "linear://example/workflow-template/new";
  const create = parseObject(await f.fields.read(source, "."));
  const createInput = record(create.input);
  expect(create.source).toBe(source);
  expect(createInput.required).toEqual(["name", "type", "descriptionData"]);
  expect(createInput.properties).not.toHaveProperty("id");
  const existing = parseObject(
    await f.fields.read(`linear://example/workflow-template/${id}#schema`, "."),
  );
  expect(record(existing.creation).source).toBe(source);
  expect(record(existing.creation).input).toEqual(createInput);
  expect(list(existing.actions).map((action) => record(action).source)).toEqual([
    `linear://example/workflow-template/${id}#fields`,
  ]);
  expect(record(existing.fields).required).toEqual(["descriptionData"]);
  expect(record(existing.fields).properties).not.toHaveProperty("name");
  expect(record(existing.fields).properties).not.toHaveProperty("id");
  await f.fields.write(
    source,
    JSON.stringify({ name: "Fixture", type: "document", descriptionData: body }),
    ".",
  );
  expect(f.invoke.mock.calls.at(-1)?.slice(1, 3)).toEqual([
    "create_workflow_template",
    { name: "Fixture", type: "document", descriptionData: body },
  ]);
});
test("the creation result identifies the operation actually dispatched by the backend", async () => {
  const f = fixture();
  const handler = createLinearOperationHandlers(f.backend, () => {}).write;
  const result = await handler.execute(
    { cwd: ".", sourceDocument: { content: "" } },
    {
      path: "linear://example/workflow-template/new",
      content: JSON.stringify({ name: "Fixture", type: "document", descriptionData: body }),
    },
  );
  expect(result.data).toMatchObject({ operation: "create_workflow_template", effect: "applied" });
  expect(result.summary).toContain("create_workflow_template");
});
test("an uncertain template creation exposes its correlation resource without replay", async () => {
  const f = fixture();
  f.backend.invoke = vi.fn(async (workspace: string, operation: string) => ({
    workspace,
    operation,
    effect: "unknown" as const,
    targetId: id,
    error: "LINEAR_NATIVE_WRITE_UNKNOWN",
  }));
  await expect(
    f.fields.write(
      "linear://example/workflow-template/new",
      JSON.stringify({ name: "Fixture", type: "document", descriptionData: body }),
      ".",
    ),
  ).rejects.toMatchObject({
    source: `linear://example/workflow-template/${id}`,
    effect: "unknown",
  });
  expect(f.backend.invoke).toHaveBeenCalledOnce();
});
test("unknown semantic creation preserves recovery data and the ordinary error flag", async () => {
  const f = fixture();
  f.backend.invoke = vi.fn(async (workspace: string, operation: string) => ({
    workspace,
    operation,
    effect: "unknown" as const,
    targetId: id,
    error: "LINEAR_NATIVE_WRITE_UNKNOWN",
  }));
  const result = await createLinearOperationHandlers(f.backend, () => {}).write.execute(
    { cwd: ".", sourceDocument: { content: "" } },
    {
      path: "linear://example/workflow-template/new",
      content: JSON.stringify({
        name: "Fixture",
        type: "document",
        descriptionData: body,
      }),
    },
  );
  expect(result.data).toMatchObject({
    ok: false,
    effect: "unknown",
    targetId: id,
    error: "LINEAR_NATIVE_WRITE_UNKNOWN",
    operation: "create_workflow_template",
  });
  expect(result.source).toBe(`linear://example/workflow-template/${id}`);
  expect(result.summary).toContain(result.source);
  type ResultHook = ExtensionHandler<ToolResultEvent, ToolResultEventResult>;
  let listener: ResultHook | undefined;
  connectLinearOperationReceipts({
    on(name: string, handler: ResultHook) {
      if (name === "tool_result") listener = handler;
      return () => {};
    },
  } as ExtensionAPI);
  if (!listener) throw new Error("Missing operation receipt listener");
  const completed = await listener(
    {
      type: "tool_result",
      toolCallId: "fixture-write",
      toolName: "write",
      input: {},
      isError: false,
      content: [],
      details: {
        metadata: { semanticAction: { ...result.data, source: result.source } },
      },
    },
    {} as ExtensionContext,
  );
  expect(completed?.isError).toBe(true);
  expect(completed?.details).toMatchObject({
    effect: "unknown",
    metadata: { semanticAction: result.data },
  });
  expect(f.backend.invoke).toHaveBeenCalledOnce();
});
test("template creation rejects URI identity overrides without dispatch and edits bind the existing UUID", async () => {
  const f = fixture();
  await expect(
    f.fields.write(
      "linear://example/workflow-template/new",
      JSON.stringify({ id, name: "Fixture", type: "issue", descriptionData: body }),
      ".",
    ),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_OVERRIDE" });
  expect(f.invoke).not.toHaveBeenCalled();
  await f.fields.write(
    `linear://example/workflow-template/${id}#fields`,
    JSON.stringify({ descriptionData: body }),
    ".",
  );
  expect(f.invoke.mock.calls.at(-1)?.slice(1, 3)).toEqual([
    "update_workflow_template",
    { id, descriptionData: body },
  ]);
});
