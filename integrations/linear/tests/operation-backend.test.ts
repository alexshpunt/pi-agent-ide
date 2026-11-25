import { required } from "./fixtures/check.ts";
import { access, readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon-v4";
import { expect, test, vi } from "vitest";
import { createLinearOperationBackend } from "#linear/operation-backend.ts";

const workspace = "example";
const cwd = process.cwd();
const schema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

test("capability failures retain a safe stage code and not-applied effect for Read recovery", async () => {
  const run = vi.fn(async () => {
    throw new Error("LINEAR_CAPABILITIES_RATE_LIMITED");
  });
  await expect(
    createLinearOperationBackend(run).capabilities(workspace, cwd),
  ).rejects.toMatchObject({
    code: "LINEAR_CAPABILITIES_RATE_LIMITED",
    source: "linear://example",
    effect: "not-applied",
  });
  expect(run).toHaveBeenCalledOnce();
});
test("an unclassified capability failure stays private and does not become an authentication guess", async () => {
  const run = vi.fn(async () => {
    throw new Error("private bearer token, HTTP 401 maybe");
  });
  await expect(
    createLinearOperationBackend(run).capabilities(workspace, cwd),
  ).rejects.toMatchObject({
    code: "LINEAR_CAPABILITIES_UNKNOWN",
    effect: "not-applied",
    message: "LINEAR_CAPABILITIES_UNKNOWN: linear://example",
  });
  expect(run).toHaveBeenCalledOnce();
});
test.each(["CAPABILITIES", "WORKSPACE"])(
  "a %s failure before remote dispatch is not an uncertain mutation",
  async (stage) => {
    const code = `LINEAR_${stage}_RATE_LIMITED`;
    const run = vi.fn(async () => {
      throw new Error(code);
    });
    await expect(
      createLinearOperationBackend(run).invoke(workspace, "save_issue", { id: "ENG-12" }, cwd),
    ).rejects.toMatchObject({
      code,
      effect: "not-applied",
    });
    expect(run).toHaveBeenCalledOnce();
  },
);
test.each([
  ["get_issue", "not-applied"],
  ["save_issue", "unknown"],
])("a lost %s invocation keeps its truthful effect", async (operation, effect) => {
  const run = vi.fn(async () => {
    throw new Error("LINEAR_OPERATION_TIMEOUT");
  });
  await expect(
    createLinearOperationBackend(run).invoke(workspace, operation, { id: "ENG-12" }, cwd),
  ).rejects.toMatchObject({
    code: "LINEAR_OPERATION_TIMEOUT",
    effect,
  });
  expect(run).toHaveBeenCalledOnce();
});
test("capabilities preserve public schemas without exposing backend exception text", async () => {
  const run = vi.fn(async () =>
    encode({
      capabilities: {
        workspace,
        items: [{ name: "get_issue", inputSchema: JSON.stringify(schema), annotations: "{}" }],
      },
    }),
  );
  expect(await createLinearOperationBackend(run).capabilities(workspace, cwd)).toEqual([
    { name: "get_issue", inputSchema: schema, annotations: {} },
  ]);
});

test("invocation stages complete JSON privately and removes it after an acknowledged operation", async () => {
  let staged = "";
  const run = vi.fn(async (_cwd, args: readonly string[]) => {
    staged = required(args.at(-1));
    expect(JSON.parse(await readFile(staged, "utf8"))).toEqual({
      id: "ENG-12",
      description: "Русский\nbody",
    });
    return encode({
      invocation: {
        workspace,
        operation: "save_issue",
        effect: "applied",
        data: JSON.stringify({ id: "ENG-12", title: "Saved" }),
      },
    });
  });
  const result = await createLinearOperationBackend(run).invoke(
    workspace,
    "save_issue",
    { id: "ENG-12", description: "Русский\nbody" },
    cwd,
  );
  expect(result).toMatchObject({ effect: "applied", data: { id: "ENG-12", title: "Saved" } });
  expect(run).toHaveBeenCalledOnce();
  await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unknown mutation is preserved without replay or raw backend text", async () => {
  const run = vi.fn(async () =>
    encode({
      invocation: {
        workspace,
        operation: "save_issue",
        effect: "unknown",
        error: "LINEAR_RESOURCE_FAILED",
      },
    }),
  );
  expect(
    await createLinearOperationBackend(run).invoke(workspace, "save_issue", { id: "ENG-12" }, cwd),
  ).toMatchObject({ effect: "unknown", error: "LINEAR_RESOURCE_FAILED" });
  expect(run).toHaveBeenCalledOnce();
});

test("native creation correlation survives an uncertain CLI receipt", async () => {
  const targetId = "cc4a56e3-8306-4f29-a859-bbc94618630c";
  const run = vi.fn(async () =>
    encode({
      invocation: {
        workspace,
        operation: "save_workflow_skill",
        effect: "unknown",
        error: "LINEAR_NATIVE_WRITE_UNKNOWN",
        targetId,
      },
    }),
  );
  expect(
    await createLinearOperationBackend(run).invoke(workspace, "save_workflow_skill", {}, cwd),
  ).toMatchObject({ effect: "unknown", targetId });
  expect(run).toHaveBeenCalledOnce();
});
test("a mismatched acknowledged invocation stays unknown", async () => {
  const run = vi.fn(async () =>
    encode({
      invocation: { workspace: "other", operation: "save_issue", effect: "applied", data: "{}" },
    }),
  );
  await expect(
    createLinearOperationBackend(run).invoke(workspace, "save_issue", { id: "ENG-12" }, cwd),
  ).rejects.toMatchObject({ code: "LINEAR_INVALID_OPERATION_RECEIPT", effect: "unknown" });
});

test("malformed public schemas are rejected before they are presented as capabilities", async () => {
  const run = vi.fn(async () =>
    encode({
      capabilities: {
        workspace,
        items: [{ name: "get_issue", inputSchema: "null", annotations: "{}" }],
      },
    }),
  );
  await expect(createLinearOperationBackend(run).capabilities(workspace, cwd)).rejects.toThrow(
    "LINEAR_INVALID_CAPABILITIES",
  );
});

test("cancellation and a wrong workspace fail before transport", async () => {
  const run = vi.fn();
  const backend = createLinearOperationBackend(run);
  await expect(backend.invoke("bad/workspace", "save_issue", {}, cwd)).rejects.toMatchObject({
    effect: "not-applied",
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    backend.invoke(workspace, "save_issue", {}, cwd, abort.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(run).not.toHaveBeenCalled();
});
