import { expect, test, vi } from "vitest";
import { ResourceError } from "pi-agent-ide/api/resource";
import { createLinearFields } from "#linear/fields.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

const source = "linear://example/issue/ENG-901";
const native = "https://linear.app/example/issue/ENG-901/fixture";
const reference = { id: "42908f54-91f9-4a46-8181-81fc1c3c8ee4", name: "Release α" };
function fixture(values: Record<string, unknown>, supported = true) {
  const invoke = vi.fn(async (workspace: string, operation: string) => ({
    workspace,
    operation,
    effect: "applied" as const,
    data: {
      id: "23317730-544b-49a5-bbdc-78f685e76555",
      identifier: "ENG-901",
      title: "Fixture title",
      ...values,
    },
  }));
  const backend: LinearOperationBackend = {
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
            title: { type: "string" },
            ...(supported ? { milestone: { type: "string" } } : {}),
          },
        },
        annotations: {},
      },
    ],
    invoke,
  };
  return { fields: createLinearFields(backend), invoke };
}

test.each([source, native])(
  "issue milestone references retain their identity at %s",
  async (address) => {
    for (const key of ["milestone", "projectMilestone"]) {
      const { fields, invoke } = fixture({ [key]: reference });
      expect(JSON.parse(await fields.read(`${address}#milestone`, process.cwd()))).toEqual(
        reference,
      );
      expect(invoke.mock.calls.map(([, operation]) => operation)).toEqual(["get_issue"]);
    }
  },
);

test.each(["milestone", "projectMilestone"])(
  "only an explicit unset %s becomes null",
  async (key) => {
    const { fields } = fixture({ [key]: null });
    expect(await fields.read(`${source}#milestone`, process.cwd())).toBe("null");
  },
);

test("an acquired MCP milestone string remains its actual value", async () => {
  const { fields } = fixture({ milestone: "Release α" });
  expect(await fields.read(`${source}#milestone`, process.cwd())).toBe("Release α");
});

test.each([
  [{}, true, "LINEAR_FIELD_NOT_EXPOSED"],
  [{ milestone: null }, false, "LINEAR_FIELD_UNSUPPORTED"],
  [{ milestone: false }, true, "LINEAR_INVALID_RESPONSE"],
  [{ milestone: 0 }, true, "LINEAR_INVALID_RESPONSE"],
  [{ milestone: " " }, true, "LINEAR_INVALID_RESPONSE"],
  [{ milestone: [] }, true, "LINEAR_INVALID_RESPONSE"],
  [{ projectMilestone: "Release α" }, true, "LINEAR_INVALID_RESPONSE"],
  [{ projectMilestone: { name: "Release α" } }, true, "LINEAR_INVALID_RESPONSE"],
  [{ projectMilestone: { id: "" } }, true, "LINEAR_INVALID_RESPONSE"],
  [{ projectMilestone: { id: reference.id, name: false } }, true, "LINEAR_INVALID_RESPONSE"],
] as const)(
  "unavailable or malformed milestone data never becomes a text anchor: %j",
  async (values, supported, code) => {
    const { fields, invoke } = fixture(values, supported);
    expect(
      await fields.resolver.tryResolve(`${source}#milestone`, { cwd: process.cwd() }),
    ).toMatchObject({
      kind: "failed",
      error: { code, effect: "not-applied" },
    });
    expect(invoke.mock.calls.map(([, operation]) => operation)).toEqual(
      supported ? ["get_issue"] : [],
    );
  },
);

test("milestone aliasing does not add a relation object to editable fields", async () => {
  const { fields } = fixture({ projectMilestone: reference });
  expect(JSON.parse(await fields.read(`${source}#fields`, process.cwd()))).toEqual({
    title: "Fixture title",
  });
});

test("milestone identity and workspace mismatches remain failed field reads", async () => {
  for (const values of [
    { identifier: "ENG-902", milestone: reference },
    { url: "https://linear.app/other/issue/ENG-901", milestone: reference },
  ]) {
    const { fields } = fixture(values);
    expect(
      await fields.resolver.tryResolve(`${source}#milestone`, { cwd: process.cwd() }),
    ).toMatchObject({
      kind: "failed",
      error: { code: "LINEAR_IDENTITY_MISMATCH", effect: "not-applied" },
    });
  }
});

test("milestone provider failures keep their safe code and are not retried", async () => {
  const { fields, invoke } = fixture({ milestone: reference });
  invoke.mockRejectedValue(
    new ResourceError("LINEAR_OPERATION_PERMISSION_DENIED", `${source}#milestone`, "not-applied"),
  );
  expect(
    await fields.resolver.tryResolve(`${source}#milestone`, { cwd: process.cwd() }),
  ).toMatchObject({
    kind: "failed",
    error: { code: "LINEAR_OPERATION_PERMISSION_DENIED", effect: "not-applied" },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});
