import { readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon-v4";
import { expect, test, vi } from "vitest";
import { createLinearTextBackend } from "#linear/text-backend.ts";
import { createLinearTextResolver } from "#linear/text-resource.ts";
import { createLinearTextCreationHandler } from "#linear/text-create.ts";
import { createLinearCommentResolver } from "#linear/comment-resource.ts";
import { parseTextAddress } from "#linear/text-address.ts";
import type { runAxi } from "#linear/axi.ts";

const id = "71000000-0000-4000-8000-000000000006";
const source = `linear://example/document/${id}/content`;
const document = {
  id,
  title: "Workpad",
  url: "https://linear.app/example/document/workpad-1234abcd5678",
};
const issue = {
  id: "ENG-12",
  title: "Fixture",
  description: "Before",
  url: "https://linear.app/example/issue/ENG-12/fixture",
};
const body = (path = source) => {
  const address = parseTextAddress(path);
  if (!address || address.kind === "create-document" || address.kind === "create-comment")
    throw Error("Expected body");
  return address;
};

function payloadFile(args: readonly string[]): string {
  const file = args.at(-1);
  if (file === undefined) throw new Error("Missing write payload file");
  return file;
}

// The saved representation may change words, spacing, widget syntax or code casing.
// Confirmed writes trust Linear rather than maintaining an equivalence allowlist.
test.each([
  source,
  "linear://example/issue/ENG-12/description",
  `linear://example/project/${id}/description`,
])(
  "confirmed text writes return Linear's representation without extra reference checks: %s",
  async (path) => {
    let content = "Before";
    const saved = `Continue in feat-<issue id="${id}" href="${issue.url}">ENG-12</issue>-work.\n\n<linear-image>{}</linear-image>`;
    const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
      if (args[1] === "update") {
        expect(await readFile(payloadFile(args), "utf8")).toBe("Continue in feat-eng-12-work.");
        content = saved;
        return encode({ document: { id } });
      }
      if (args[0] === "documents") return encode({ document: { ...document, content } });
      if (args[0] === "issues") return encode({ issue: { ...issue, description: content } });
      return encode({
        project: {
          uuid: id,
          url: "https://linear.app/example/project/test-ab12cd34ef56",
          description: content,
        },
      });
    });
    const backend = createLinearTextBackend(run);
    expect(
      await backend.save(body(path), "Before", "Continue in feat-eng-12-work.", process.cwd()),
    ).toBe(saved);
    expect(run).toHaveBeenCalledTimes(3);
  },
);

test.each(["documents/new?title=Workpad", "comments/new"])(
  "creation returns its acknowledged identity without depending on readback: %s",
  async (suffix) => {
    const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
      if (args[0] === "issues") return encode({ issue });
      if (args[1] === "create")
        return encode({ [args[0] === "documents" ? "document" : "comment"]: { id } });
      throw Error("Readback is unavailable");
    });
    const path = `linear://example/issue/ENG-12/${suffix}`;
    const handler = createLinearTextCreationHandler(createLinearTextBackend(run).create);
    const result = await handler.execute(
      { cwd: process.cwd(), sourceDocument: { content: "" } },
      {
        path,
        content: "Anything Linear transforms",
      },
    );
    expect(result.data).toMatchObject({ effect: "applied", id });
    expect(result.summary).toContain(id);
    expect(result.summary).not.toContain("normalized");
    expect(run).toHaveBeenCalledTimes(2);
  },
);

test("a write with unavailable readback stays acknowledged without fabricating a saved snapshot", async () => {
  let acknowledged = false;
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      acknowledged = true;
      return encode({ document: { id } });
    }
    if (acknowledged) throw Error("private transport output");
    return encode({ document: { ...document, content: "Before" } });
  });
  const resolved = await createLinearTextResolver(createLinearTextBackend(run)).tryResolve(source, {
    cwd: process.cwd(),
  });
  if (resolved.kind !== "resolved" || !resolved.resource.write || !resolved.resource.read)
    throw Error("Missing text resource");
  await expect(
    resolved.resource.write([{ type: "text", text: "Requested" }], {}),
  ).resolves.toBeUndefined();
  expect(resolved.resource.sourceBytes).toBeUndefined();
  await expect(resolved.resource.read({})).rejects.toMatchObject({
    code: "LINEAR_READBACK_UNAVAILABLE",
    effect: "applied",
    source,
  });
  expect(run.mock.calls.filter(([, args]) => args[1] === "update")).toHaveLength(1);
});

test("a normalized snapshot is used for the next edit's conflict check", async () => {
  let content = "Before";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      content = (await readFile(payloadFile(args), "utf8")).replace("eng-12", "ENG-12");
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content } });
  });
  const resolved = await createLinearTextResolver(createLinearTextBackend(run)).tryResolve(source, {
    cwd: process.cwd(),
  });
  if (resolved.kind !== "resolved" || !resolved.resource.write || !resolved.resource.read)
    throw Error("Missing text resource");
  await resolved.resource.write([{ type: "text", text: "feat-eng-12-work" }], {});
  expect(await resolved.resource.read({})).toEqual([{ type: "text", text: "feat-ENG-12-work" }]);
  await resolved.resource.write([{ type: "text", text: "Second edit" }], {});
  expect(content).toBe("Second edit");
});

test.each([false, true])(
  "comment writes keep their acknowledgement when readback differs or fails (unavailable=%s)",
  async (unavailable) => {
    let applied = false;
    const comment = `linear://example/issue/ENG-12/comment/${id}#body`;
    const invoke = vi.fn(async () => {
      applied = true;
      return { workspace: "example", operation: "save_comment", effect: "applied" as const };
    });
    const resolved = await createLinearCommentResolver(
      { capabilities: async () => [], invoke },
      async () => {
        if (applied && unavailable) throw Error("private transport output");
        return {
          source: comment,
          content: applied ? "Server representation" : "Before",
          complete: true,
        };
      },
    ).tryResolve(comment, { cwd: process.cwd() });
    if (resolved.kind !== "resolved" || !resolved.resource.write || !resolved.resource.read)
      throw Error("Missing comment");
    await expect(
      resolved.resource.write([{ type: "text", text: "Requested" }], {}),
    ).resolves.toBeUndefined();
    if (unavailable) {
      expect(resolved.resource.sourceBytes).toBeUndefined();
      await expect(resolved.resource.read({})).rejects.toMatchObject({
        code: "LINEAR_READBACK_UNAVAILABLE",
        effect: "applied",
      });
    } else
      expect(await resolved.resource.read({})).toEqual([
        { type: "text", text: "Server representation" },
      ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);
