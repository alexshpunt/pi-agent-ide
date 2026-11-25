import { fixtureHost, jsonRecord, required } from "./fixtures/check.ts";
import { expect, test, vi } from "vitest";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import { createLinearFields } from "#linear/fields.ts";
import {
  connectLinearPermissionGate,
  createLinearOperationHandlers,
} from "#linear/operation-actions.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

const id = "10000000-0000-4000-8000-000000000001";
const context = { cwd: "/fixture" };
const routes = [
  ["document", "delete_document"],
  ["workflow-skill", "delete_workflow_skill"],
  ["workflow-template", "delete_workflow_template"],
  ["template", "delete_workflow_template"],
] as const;
function backend(effect: "applied" | "not-applied" | "unknown" = "applied") {
  const invoke = vi.fn(async (workspace: string, operation: string) => ({
    workspace,
    operation,
    effect,
    targetId: id,
    data: effect === "applied" ? { id, success: true } : null,
    ...(effect === "applied" ? {} : { error: "LINEAR_GRAPHQL_FAILED" }),
  }));
  const value: LinearOperationBackend = { capabilities: async () => [], invoke };
  return { value, invoke };
}
test.each(routes)(
  "Delete binds the approved %s identity to its native operation",
  async (kind, operation) => {
    const f = backend();
    const permit = vi.fn();
    const path = `linear://example/${kind}/${id}`;
    const result = await createLinearOperationHandlers(f.value, permit).fileOperations(
      "delete",
      { path },
      context,
    );
    expect(result).toMatchObject({
      kind: "file-operation",
      operation: "delete",
      path,
      ok: true,
      effect: "applied",
    });
    expect(permit).toHaveBeenCalledExactlyOnceWith(path, "");
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith(
      "example",
      operation,
      { id },
      context.cwd,
      undefined,
    );
  },
);
test.each(routes)("a refused %s Delete cannot dispatch", async (kind) => {
  const f = backend();
  const path = `linear://example/${kind}/${id}`;
  const handler = createLinearOperationHandlers(f.value, () => {
    throw new ResourceError("LINEAR_CONFIRMATION_REQUIRED", path, "not-applied");
  });
  await expect(handler.fileOperations("delete", { path }, context)).rejects.toMatchObject({
    code: "LINEAR_CONFIRMATION_REQUIRED",
    effect: "not-applied",
  });
  expect(f.invoke).not.toHaveBeenCalled();
});
test("an uncertain native deletion stays uncertain and is never dispatched twice", async () => {
  const f = backend("unknown");
  const path = `linear://example/document/${id}`;
  const result = await createLinearOperationHandlers(f.value, () => {}).fileOperations(
    "delete",
    { path },
    context,
  );
  expect(result).toMatchObject({
    ok: false,
    effect: "unknown",
    error: { code: "LINEAR_GRAPHQL_FAILED" },
  });
  expect(f.invoke).toHaveBeenCalledOnce();
});
test("collection, creation and body addresses cannot delete another resource", async () => {
  const f = backend();
  const handler = createLinearOperationHandlers(f.value, () => {});
  for (const path of ["linear://example/document", "linear://example/document/new"]) {
    await expect(handler.fileOperations("delete", { path }, context)).rejects.toMatchObject({
      code: "LINEAR_IDENTITY_REQUIRED",
      effect: "not-applied",
    });
  }
  for (const path of [
    `linear://example/document/${id}#body`,
    `linear://example/workflow-skill/${id}#schema`,
    `linear://example/agent-skill/${id}`,
  ]) {
    expect(await handler.fileOperations("delete", { path }, context)).toBeUndefined();
  }
  expect(f.invoke).not.toHaveBeenCalled();
});
test.each(routes)(
  "the %s action schema advertises an executable whole-resource Delete",
  async (kind, operation) => {
    const f = backend();
    const names = [
      "get_document",
      "save_document",
      "get_template",
      "get_workflow_skill",
      "save_workflow_skill",
      "get_workflow_template",
      "update_workflow_template",
      operation,
    ];
    f.value.capabilities = async () =>
      names.map((name) => ({
        name,
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        annotations: {},
      }));
    const source = `linear://example/${kind}/${id}`;
    const schema = jsonRecord(
      await createLinearFields(f.value).read(`${source}#actions`, context.cwd),
    );
    expect(schema.actions).toContainEqual(
      expect.objectContaining({ source, tool: "delete", approvalRequired: true }),
    );
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
test("the standalone approval gate rejects headless deletion and consumes only the exact approved target", async () => {
  let registered: ((event: ToolCallEvent, context: ExtensionContext) => unknown) | undefined;
  const events = createEventBus();
  const inherited = vi.fn();
  events.on("pi-agent-ide/approval/request/v1", inherited);
  const on = ((
    event: string,
    handler: (event: ToolCallEvent, context: ExtensionContext) => unknown,
  ) => {
    if (event === "tool_call") registered = handler;
    return () => {};
  }) as ExtensionAPI["on"];
  const permit = connectLinearPermissionGate(fixtureHost<ExtensionAPI>({ on, events }), () => true);
  const path = `linear://example/document/${id}`;
  const event: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "delete-test",
    toolName: "linear_delete",
    input: { path },
  };
  const hook = required(registered);
  expect(await hook(event, fixtureHost<ExtensionContext>({ hasUI: false }))).toMatchObject({
    block: true,
  });
  expect(() => permit(path, "")).toThrow("LINEAR_CONFIRMATION_REQUIRED");
  const confirm = vi.fn(async () => false);
  expect(
    await hook(event, fixtureHost<ExtensionContext>({ hasUI: true, ui: { confirm } })),
  ).toMatchObject({ block: true });
  expect(() => permit(path, "")).toThrow("LINEAR_CONFIRMATION_REQUIRED");
  confirm.mockResolvedValue(true);
  expect(
    await hook(event, fixtureHost<ExtensionContext>({ hasUI: true, ui: { confirm } })),
  ).toBeUndefined();
  expect(() => permit(`linear://example/workflow-skill/${id}`, "")).toThrow(
    "LINEAR_CONFIRMATION_REQUIRED",
  );
  expect(() => permit(path, "")).not.toThrow();
  expect(() => permit(path, "")).toThrow("LINEAR_CONFIRMATION_REQUIRED");
  expect(inherited).not.toHaveBeenCalled();
});
