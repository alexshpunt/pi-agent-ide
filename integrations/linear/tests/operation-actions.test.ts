import { expect, test, vi } from "vitest";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { registerOperationApproval } from "pi-agent-ide/api/approval";
import type { LinearOperationBackend, LinearOperationReceipt } from "#linear/operation-backend.ts";
import {
  connectLinearPermissionGate,
  createLinearOperationHandlers,
} from "#linear/operation-actions.ts";

type CallHook = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

function gateFixture(standalone: boolean, isAllowed?: () => Promise<boolean>) {
  let hook: CallHook | undefined;
  const on: ExtensionAPI["on"] = (name: string, handler: unknown) => {
    if (name === "tool_call" && typeof handler === "function") hook = handler as CallHook;
    return () => {};
  };
  const pi = { ...({} as ExtensionAPI), events: createEventBus(), on };
  if (isAllowed) registerOperationApproval(pi, { isAllowed });
  const permit = connectLinearPermissionGate(pi, () => standalone);
  function call(
    toolName: string,
    input: Record<string, unknown>,
    hasUI: boolean,
    confirm?: () => Promise<boolean>,
  ) {
    if (!hook) throw new Error("Missing tool call hook");
    const context: ExtensionContext = {
      ...({} as ExtensionContext),
      cwd: process.cwd(),
      hasUI,
      mode: "tui",
      ui: {
        ...({} as ExtensionContext["ui"]),
        confirm: confirm ?? (() => Promise.resolve(false)),
      },
    };
    return hook({ type: "tool_call", toolCallId: "fixture", toolName, input }, context);
  }
  return { permit, call };
}

function backend() {
  const invoke = vi.fn(
    async (
      workspace: string,
      operation: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<LinearOperationReceipt> => ({
      workspace,
      operation,
      effect: "applied",
      data:
        operation === "save_issue"
          ? {
              id: "ENG-99",
              url: "https://linear.app/example/issue/ENG-99/fixture",
              title: input.title,
            }
          : { id: "diff-1", url: "https://linear.app/example/diff/diff-1", title: "Fixture" },
    }),
  );
  const value: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "save_issue",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            team: { type: "string" },
          },
        },
        annotations: {},
      },
      {
        name: "merge_diff",
        inputSchema: { type: "object", properties: { urlOrId: { type: "string" } } },
        annotations: {},
      },
      {
        name: "get_diff",
        inputSchema: { type: "object", properties: { urlOrId: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
    ],
    invoke,
  };
  return { value, invoke };
}
const context = { cwd: process.cwd(), sourceDocument: { content: "" } };

test("standalone high-risk tools always confirm and never inherit an IDE bypass", async () => {
  const inheritedPolicy = vi.fn(async () => true);
  const { call, permit } = gateFixture(true, inheritedPolicy);
  const input = { path: "linear://example/diff/diff-1#merge", content: "{}" };
  const confirm = vi.fn(async () => false);
  expect(await call("linear_read", input, false)).toBeUndefined();
  expect(await call("linear_write", input, false)).toMatchObject({ block: true });
  expect(await call("linear_write", input, true, confirm)).toMatchObject({ block: true });
  expect(() => permit(input.path, input.content)).toThrow("LINEAR_CONFIRMATION_REQUIRED");
  confirm.mockResolvedValue(true);
  expect(await call("linear_write", input, true, confirm)).toBeUndefined();
  expect(() => permit(input.path, input.content)).not.toThrow("LINEAR_CONFIRMATION_REQUIRED");
  expect(() => permit(input.path, input.content)).toThrow("LINEAR_CONFIRMATION_REQUIRED");
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(inheritedPolicy).not.toHaveBeenCalled();
});

test("creation is one typed Write and returns the saved identity, not /new", async () => {
  const f = backend();
  const handler = createLinearOperationHandlers(f.value, () => {
    throw new Error("Unexpected approval");
  }).write;
  const input = { path: "linear://example/issue/new", content: '{"team":"ENG","title":"Fixture"}' };
  expect(handler.matches(input)).toBe(true);
  const result = await handler.execute(context, input);
  expect(result.source).toBe("linear://example/issue/ENG-99");
  expect(result.data).toMatchObject({ effect: "applied", operation: "save_issue" });
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("an acknowledged creation without identity stays unknown and is never repeated", async () => {
  const f = backend();
  f.value.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation): Promise<LinearOperationReceipt> => ({
      workspace,
      operation,
      effect: "applied",
      data: { success: true },
    }),
  );
  await expect(
    createLinearOperationHandlers(f.value, () => {}).write.execute(context, {
      path: "linear://example/issue/new",
      content: '{"team":"ENG","title":"Fixture"}',
    }),
  ).rejects.toMatchObject({ effect: "unknown", code: "LINEAR_CREATION_RECEIPT_INVALID" });
  expect(f.value.invoke).toHaveBeenCalledOnce();
});

test("high-risk action cannot be dispatched through an unapproved handler", async () => {
  const f = backend();
  await expect(
    createLinearOperationHandlers(f.value, () => {
      throw new Error("confirmation refused");
    }).write.execute(context, {
      path: "linear://example/diff/diff-1#merge",
      content: "{}",
    }),
  ).rejects.toThrow("confirmation refused");
  expect(f.invoke.mock.calls.some(([, operation]) => operation === "merge_diff")).toBe(false);
});

test("permission gate does not block reading a high-risk action schema and refuses unattended writes", async () => {
  const { call, permit } = gateFixture(false);
  const input = { path: "linear://example/diff/diff-1#merge", content: "{}" };
  expect(await call("read", input, false)).toBeUndefined();
  expect(await call("write", input, false)).toMatchObject({ block: true });
  expect(() => permit(input.path, input.content)).toThrow("LINEAR_CONFIRMATION_REQUIRED");
});

test("approval binds the exact target and payload and is consumed once", async () => {
  const { call, permit } = gateFixture(false, async () => true);
  const input = { path: "linear://example/diff/diff-1#merge", content: "{}" };
  expect(await call("write", input, true)).toBeUndefined();

  expect(() => permit("linear://example/diff/diff-2#merge", input.content)).toThrow(
    "LINEAR_CONFIRMATION_REQUIRED",
  );
  expect(() => permit(input.path, '{"mergeMethod":"squash"}')).toThrow(
    "LINEAR_CONFIRMATION_REQUIRED",
  );
  expect(() => permit(input.path, input.content)).not.toThrow("LINEAR_CONFIRMATION_REQUIRED");
  expect(() => permit(input.path, input.content)).toThrow("LINEAR_CONFIRMATION_REQUIRED");
});

test("a created project comment returns a contextual Read link rather than an unreadable bare comment", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const project = "22222222-2222-4222-8222-222222222222";
  const value: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "save_comment",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            projectId: { type: "string" },
            body: { type: "string" },
          },
        },
        annotations: {},
      },
    ],
    invoke: vi.fn<LinearOperationBackend["invoke"]>(
      async (workspace, operation): Promise<LinearOperationReceipt> => ({
        workspace,
        operation,
        effect: "applied",
        data: { id, body: "Comment" },
      }),
    ),
  };
  const result = await createLinearOperationHandlers(value, () => {}).write.execute(context, {
    path: "linear://example/comment/new",
    content: JSON.stringify({ projectId: project, body: "Comment" }),
  });
  expect(result.source).toBe(`linear://example/project/${project}/comment/${id}`);
});

test.each(["", "Bug"])(
  "Insert adds a label to an empty or populated set (%s) without removing members",
  async (initial) => {
    let labels = initial ? [initial] : [];
    const value: LinearOperationBackend = {
      capabilities: async () => [
        {
          name: "get_issue",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          annotations: {},
        },
        {
          name: "save_issue",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              labels: { type: "array", items: { type: "string" } },
            },
          },
          annotations: {},
        },
      ],
      invoke: vi.fn<LinearOperationBackend["invoke"]>(
        async (workspace, operation, input): Promise<LinearOperationReceipt> => {
          if (operation === "save_issue") labels = input.labels as string[];
          return { workspace, operation, effect: "applied", data: { id: "ENG-12", labels } };
        },
      ),
    };
    const handler = createLinearOperationHandlers(value, () => {}).insert;
    const input = { path: "linear://example/issue/ENG-12#labels", after: "end", text: "Feature" };
    expect(handler.matches(input)).toBe(true);
    expect(handler.matches({ path: input.path, before: "end", text: input.text })).toBe(false);
    await handler.execute(context, input);
    expect(labels).toEqual(initial ? ["Bug", "Feature"] : ["Feature"]);
  },
);
