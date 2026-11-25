import { required } from "./fixtures/check.ts";
import { expect, test, vi } from "vitest";
import { createLinearFields } from "#linear/fields.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

const source = "linear://example/issue/ENG-901";
function fixture(delegate: unknown) {
  const invoke = vi.fn(
    async (workspace: string, operation: string, input: Record<string, unknown>) => ({
      workspace,
      operation,
      effect: "applied" as const,
      data: {
        id: "ENG-901",
        title: "Fixture title",
        // Like the real backend, the default card omits delegate unless it is requested.
        ...(Array.isArray(input.fields) && input.fields.includes("delegate") ? { delegate } : {}),
      },
    }),
  );
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "get_issue",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            fields: {
              type: "array",
              items: { type: "string", enum: ["id", "delegate", "status"] },
            },
          },
        },
        annotations: {},
      },
      {
        name: "save_issue",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            delegate: { type: ["string", "null"] },
          },
        },
        annotations: {},
      },
    ],
    invoke,
  };
  return { fields: createLinearFields(backend), invoke };
}

test("a delegate the default card omits is requested explicitly", async () => {
  const { fields, invoke } = fixture({ id: "agent-id", name: "clanker" });
  expect(await fields.read(`${source}#delegate`, process.cwd())).toBe("clanker");
  expect(invoke.mock.calls.map(([, , input]) => input.fields)).toEqual([["delegate"]]);
});

test("an unset delegate reads as null once it is explicitly requested", async () => {
  const { fields } = fixture(null);
  expect(await fields.read(`${source}#delegate`, process.cwd())).toBe("null");
});

test("delegate can be written without a prior read", async () => {
  const { fields, invoke } = fixture(null);
  const attempt = await fields.resolver.tryResolve(`${source}#delegate`, {
    cwd: process.cwd(),
  });
  if (attempt.kind !== "resolved") throw new Error("delegate did not resolve");
  await required(attempt.resource.write)([{ type: "text", text: "clanker" }], {});
  const save = invoke.mock.calls.find(([, operation]) => operation === "save_issue");
  expect(save?.[2]).toMatchObject({ id: "ENG-901", delegate: "clanker" });
});
