import { required } from "./fixtures/check.ts";
import { expect, test, vi } from "vitest";
import { createLinearOperationHandlers } from "#linear/operation-actions.ts";
import { connectLinearDomainReadRecovery, readLinearDomain } from "#linear/domain-read.ts";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import type { LinearOperationBackend, LinearOperationReceipt } from "#linear/operation-backend.ts";

const id = "a8852949-289a-454e-8950-ced239500f26";
const project = "Project & milestones";
const source = `linear://example/milestone/${id}`;
const context = { cwd: process.cwd(), sourceDocument: { content: "" } };

function recoveryHook() {
  let registered: ((event: ToolResultEvent) => unknown) | undefined;
  connectLinearDomainReadRecovery({
    on: (name: string, handler: (event: ToolResultEvent) => unknown) => {
      expect(name).toBe("tool_result");
      registered = handler;
      return () => {};
    },
  } as ExtensionAPI);
  return required(registered);
}
test.each(["", "?project=", "?other=value"])(
  "missing milestone project recovery preserves safe error data (%s)",
  (suffix) => {
    const hook = recoveryHook();
    const path = source + suffix;
    const event: ToolResultEvent = {
      type: "tool_result",
      toolCallId: "milestone-test",
      input: { path },
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "Read failed" }],
      details: {
        failure: {
          cause: new ResourceError("LINEAR_OPERATION_INPUT_REQUIRED", path, "not-applied"),
        },
      },
      structuredContent: {
        status: "error",
        errors: [{ code: "LINEAR_OPERATION_INPUT_REQUIRED", source: path, message: "Read failed" }],
      },
    };
    const result = hook(event);
    expect(result).toHaveProperty(
      "structuredContent.errors.0.code",
      "LINEAR_OPERATION_INPUT_REQUIRED",
    );
    expect(result).toHaveProperty("structuredContent.errors.0.source", path);
    const recovery = JSON.stringify(result);
    expect(recovery).toContain(path + "#schema");
    expect(recovery).toContain("project=<value>");
    expect(event.content).toHaveLength(1);
    expect(hook({ ...event, isError: false })).toBeUndefined();
    expect(
      hook({
        ...event,
        details: { failure: { cause: { code: "LINEAR_OPERATION_INPUT_REQUIRED", source: path } } },
      }),
    ).toBeUndefined();
  },
);
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
      data: { id, name: "First milestone", project: input.project },
    }),
  );
  const value: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "save_milestone",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            project: { type: "string" },
            name: { type: "string" },
          },
          required: ["project"],
        },
        annotations: {},
      },
      {
        name: "get_milestone",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" }, query: { type: "string" } },
          required: ["project", "query"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
    invoke,
  };
  return { value, invoke };
}

test.each([false, true])(
  "a created milestone link keeps its project and can be read (project in URL: %s)",
  async (inUrl) => {
    const b = backend();
    const path = `linear://example/milestone/new${inUrl ? `?project=${encodeURIComponent(project)}` : ""}`;
    const content = JSON.stringify({ name: "First milestone", ...(inUrl ? {} : { project }) });
    const result = await createLinearOperationHandlers(b.value, () => {}).write.execute(context, {
      path,
      content,
    });
    const url = new URL(result.source);
    expect(url.pathname).toBe(`/milestone/${id}`);
    expect(url.searchParams.get("project")).toBe(project);
    expect(result.summary).toContain(`Read: ${result.source}`);
    expect(result.data).toMatchObject({ source: result.source, effect: "applied" });
    expect(await readLinearDomain(result.source, process.cwd(), undefined, b.value)).toContain(
      "First milestone",
    );
    expect(b.invoke.mock.calls.map(([, operation, input]) => [operation, input])).toEqual([
      ["save_milestone", { project, name: "First milestone" }],
      ["get_milestone", { project, query: id }],
    ]);
  },
);

test("a bare milestone link rejects before invoking Linear", async () => {
  const b = backend();
  await expect(readLinearDomain(source, process.cwd(), undefined, b.value)).rejects.toMatchObject({
    code: "LINEAR_OPERATION_INPUT_REQUIRED",
    source,
    effect: "not-applied",
  });
  expect(b.invoke).not.toHaveBeenCalled();
});
