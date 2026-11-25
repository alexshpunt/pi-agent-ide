import { ResourceError } from "pi-agent-ide/api/resource";
import { expect, test, vi } from "vitest";
import { createLinearCommentResolver } from "#linear/comment-resource.ts";
import type { LinearOperationBackend, LinearOperationReceipt } from "#linear/operation-backend.ts";

const source = "linear://example/issue/ENG-12/comment/11111111-1111-4111-8111-111111111111#body";
const context = { cwd: process.cwd() };
function fixture(
  mode:
    | "save"
    | "normalized"
    | "stale"
    | "mismatch"
    | "unknown"
    | "lost"
    | "lost-process"
    | "receipt",
) {
  let body = "Before";
  const invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input): Promise<LinearOperationReceipt> => {
      if (mode === "unknown")
        return { workspace, operation, effect: "unknown", error: "LINEAR_RESOURCE_FAILED" };
      // Linear saved the body, but its response never arrived.
      if (mode === "lost") {
        body = String(input.body);
        return { workspace, operation, effect: "unknown", error: "LINEAR_OPERATION_TIMEOUT" };
      }
      if (mode === "lost-process") {
        body = String(input.body);
        throw new ResourceError("LINEAR_AXI_TIMEOUT", `linear://${workspace}`, "unknown");
      }
      if (mode === "receipt") {
        body = String(input.body).replace(/\n$/u, "");
        return { workspace, operation, effect: "applied", data: { id: String(input.id), body } };
      }
      if (mode === "save") body = String(input.body).replace(/\n$/u, "");
      if (mode === "normalized") body = String(input.body).replace("- [x]", "* [X]");
      return {
        workspace,
        operation,
        effect: "applied",
        data: { id: "11111111-1111-4111-8111-111111111111" },
      };
    },
  );
  const backend: LinearOperationBackend = { capabilities: async () => [], invoke };
  let reads = 0;
  const read = vi.fn(async () => ({
    source: source.split("#")[0],
    content: mode === "stale" && reads++ ? "External change" : body,
    complete: true,
  }));
  return { resolver: createLinearCommentResolver(backend, read), invoke, read };
}
async function resource(mode: Parameters<typeof fixture>[0]) {
  const f = fixture(mode);
  const result = await f.resolver.tryResolve(source, context);
  if (result.kind !== "resolved" || !result.resource.write || !result.resource.read)
    throw new Error("Expected writable comment");
  return { ...f, write: result.resource.write, readSaved: result.resource.read };
}

test("comment edits preserve the UUID and parent, with final newline normalization", async () => {
  const f = await resource("save");
  await f.write([{ type: "text", text: "Changed\n" }], {});
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.invoke.mock.calls[0]?.[2]).toEqual({
    id: "11111111-1111-4111-8111-111111111111",
    body: "Changed\n",
  });
  expect(await f.readSaved({})).toEqual([{ type: "text", text: "Changed" }]);
});

test("the saved body from the save response serves the next Read without another lookup", async () => {
  const f = await resource("receipt");
  // One lookup to resolve and one pre-save conflict check.
  expect(f.read).toHaveBeenCalledTimes(1);
  await f.write([{ type: "text", text: "Changed\n" }], {});
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(await f.readSaved({})).toEqual([{ type: "text", text: "Changed" }]);
  expect(f.read).toHaveBeenCalledTimes(2);
});

test("comment edits keep the actual normalized checkbox text without replay", async () => {
  const f = await resource("normalized");
  await f.write([{ type: "text", text: "- [x] Finished" }], {});
  expect(await f.readSaved({})).toEqual([{ type: "text", text: "* [X] Finished" }]);
  expect(f.invoke).toHaveBeenCalledTimes(1);
});
test("a stale comment refuses before any save", async () => {
  const f = await resource("stale");
  await expect(f.write([{ type: "text", text: "Changed" }], {})).rejects.toMatchObject({
    code: "LINEAR_STALE_CONTENT",
    effect: "not-applied",
  });
  expect(f.invoke).not.toHaveBeenCalled();
});
test.each(["unknown"] as const)(
  "an %s acknowledgement never becomes a successful edit or a retry",
  async (mode) => {
    const f = await resource(mode);
    await expect(f.write([{ type: "text", text: "Changed" }], {})).rejects.toMatchObject({
      effect: "unknown",
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  },
);

test.each(["lost", "lost-process"] as const)(
  "an unknown save (%s) whose readback already shows the requested body is applied",
  async (mode) => {
    const f = await resource(mode);
    await f.write([{ type: "text", text: "Changed" }], {});
    expect(await f.readSaved({})).toEqual([{ type: "text", text: "Changed" }]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  },
);

test("a confirmed comment accepts the saved representation without comparing it", async () => {
  const f = await resource("mismatch");
  await f.write([{ type: "text", text: "Changed" }], {});
  expect(await f.readSaved({})).toEqual([{ type: "text", text: "Before" }]);
  expect(f.invoke).toHaveBeenCalledTimes(1);
});
