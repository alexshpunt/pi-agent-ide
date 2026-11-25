import { access, readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon-v4";
import { expect, test, vi } from "vitest";
import { createLinearTextBackend } from "#linear/text-backend.ts";
import { createLinearTextResolver } from "#linear/text-resource.ts";
import { parseTextAddress } from "#linear/text-address.ts";
import type { runAxi } from "#linear/axi.ts";

const id = "71000000-0000-4000-8000-000000000006";
const doc = `linear://example/document/${id}/content`;
const issue = {
  id: "ENG-12",
  title: "Keep title",
  description: "Before",
  url: "https://linear.app/example/issue/ENG-12/title",
};
const document = {
  id,
  title: "Workpad",
  content: "Before",
  url: "https://linear.app/example/document/workpad-1234abcd5678",
};
const address = (source: string) => {
  const result = parseTextAddress(source);
  if (!result || result.kind === "create-document" || result.kind === "create-comment")
    throw new Error("body required");
  return result;
};

test.each([
  doc,
  "linear://example/issue/ENG-12/description",
  `linear://example/project/${id}/description`,
])("reads only the original body, not card metadata: %s", async (source) => {
  const run = vi.fn<typeof runAxi>(async (_cwd, args) =>
    encode(
      args[0] === "documents"
        ? { document }
        : args[0] === "issues"
          ? { issue }
          : {
              project: {
                uuid: id,
                description: "Before",
                url: "https://linear.app/example/project/test-ab12cd34ef56/overview",
              },
            },
    ),
  );
  const result = await createLinearTextResolver(createLinearTextBackend(run)).tryResolve(source, {
    cwd: process.cwd(),
  });
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved" || !result.resource.read) throw new Error("missing resource");
  expect(await result.resource.read({})).toEqual([{ type: "text", text: "Before" }]);
  expect(result.resource.sourceBytes && Buffer.from(result.resource.sourceBytes).toString()).toBe(
    "Before",
  );
});

function payloadFile(args: readonly string[]): string {
  const file = args.at(-1);
  if (file === undefined) throw new Error("Missing write payload file");
  return file;
}

const asset = "https://uploads.linear.app/workspace/upload/file";

test.each([
  doc,
  "linear://example/issue/ENG-12/description",
  `linear://example/project/${id}/description`,
])("asset signatures do not change body snapshots or block saves: %s", async (source) => {
  let body = `Before [file](<${asset}?signature=old>)`;
  let views = 0;
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      body = await readFile(payloadFile(args), "utf8");
      return encode({ document: { id } });
    }
    const signed = body.replace(/(?:\?signature=old)?(?=>)/u, `?signature=read-${++views}`);
    return encode(
      args[0] === "documents"
        ? { document: { ...document, content: signed } }
        : args[0] === "issues"
          ? { issue: { ...issue, description: signed } }
          : {
              project: {
                uuid: id,
                description: signed,
                url: "https://linear.app/example/project/test-ab12cd34ef56/overview",
              },
            },
    );
  });
  const backend = createLinearTextBackend(run);
  const first = await backend.read(address(source), process.cwd());
  expect(first.content).toBe(`Before [file](<${asset}>)`);
  expect(await backend.read(address(source), process.cwd())).toEqual(first);
  const wanted = `Changed [file](<${asset}>)`;
  expect(await backend.save(address(source), first.content, wanted, process.cwd())).toBe(wanted);
  expect(body).toBe(wanted);
  expect(run.mock.calls.filter(([, args]) => args[1] === "update")).toHaveLength(1);
});

test.each([
  `Other [file](<${asset}?signature=new>)`,
  `Before [file](<${asset}-other?signature=new>)`,
  `Before [file](<${asset}?version=2&signature=new>)`,
  "Before [file](<https://example.com/file?signature=new>)",
])("real body changes still reject the save: %s", async (description) => {
  const run = vi.fn(async () => encode({ issue: { ...issue, description } }));
  await expect(
    createLinearTextBackend(run).save(
      address("linear://example/issue/ENG-12/description"),
      `Before [file](<${asset}>)`,
      "Wrong",
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_STALE_CONTENT", effect: "not-applied" });
  expect(run).toHaveBeenCalledTimes(1);
});
test("an exported request with an adjacent asset URL can append despite renewed signatures", async () => {
  let body = `Manifest URL${asset}. Task follows.`;
  let views = 0;
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      body = await readFile(payloadFile(args), "utf8");
      return encode({ document: { id } });
    }
    return encode({
      document: {
        ...document,
        content: body.replace(asset, `${asset}?signature=read-${++views}`),
      },
    });
  });
  const backend = createLinearTextBackend(run);
  const before = await backend.read(address(doc), process.cwd());
  const wanted = `${before.content}\n\nThe user's next request.`;
  expect(await backend.save(address(doc), before.content, wanted, process.cwd())).toBe(wanted);
  expect(body).toBe(wanted);
  expect(run.mock.calls.filter(([, args]) => args[1] === "update")).toHaveLength(1);
});
test("asset URLs embedded in external links cannot hide real conflicts", async () => {
  const external = `https://example.com/?return=${asset}?signature=`;
  const run = vi.fn(async () =>
    encode({
      issue: { ...issue, description: `[external](<${external}new>)` },
    }),
  );
  await expect(
    createLinearTextBackend(run).save(
      address("linear://example/issue/ENG-12/description"),
      `[external](<${external}old>)`,
      "Wrong",
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_STALE_CONTENT", effect: "not-applied" });
  expect(run).toHaveBeenCalledTimes(1);
});
test("stale content is rejected before dispatching a mutation", async () => {
  const run = vi.fn(async () => encode({ document }));
  await expect(
    createLinearTextBackend(run).save(address(doc), "Old", "Changed", process.cwd()),
  ).rejects.toMatchObject({ code: "LINEAR_STALE_CONTENT", effect: "not-applied" });
  expect(run).toHaveBeenCalledTimes(1);
});

test("wrong workspace cannot dispatch a create", async () => {
  const run = vi.fn(async () => encode({ issue }));
  const creation = parseTextAddress("linear://other/issue/ENG-12/documents/new?title=Workpad");
  if (creation?.kind !== "create-document") throw new Error("creation required");
  await expect(
    createLinearTextBackend(run).create(creation, "body", process.cwd()),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_MISMATCH", effect: "not-applied" });
  expect(run).toHaveBeenCalledTimes(1);
});

test("text upload is hidden, removed afterwards and saved content is reread", async () => {
  let content = "Before";
  let staged = "";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      staged = payloadFile(args);
      content = await readFile(staged, "utf8");
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content } });
  });
  await createLinearTextBackend(run).save(
    address(doc),
    "Before",
    "Changed\nРусский & text",
    process.cwd(),
  );
  expect(content).toBe("Changed\nРусский & text");
  expect(run).toHaveBeenCalledTimes(3);
  await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
});

test("uncertain save is never replayed and does not expose backend output", async () => {
  let staged = "";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] !== "update") return encode({ document });
    staged = payloadFile(args);
    throw new Error("secret signed URL");
  });
  await expect(
    createLinearTextBackend(run).save(address(doc), "Before", "Changed", process.cwd()),
  ).rejects.toMatchObject({ code: "LINEAR_SAVE_FAILED", effect: "unknown" });
  expect(run).toHaveBeenCalledTimes(2);
  await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an acknowledged save accepts the representation returned by Linear", async () => {
  const run = vi.fn<typeof runAxi>(async (_cwd, args) =>
    args[1] === "update" ? encode({ document: { id } }) : encode({ document }),
  );
  await expect(
    createLinearTextBackend(run).save(address(doc), "Before", "Changed", process.cwd()),
  ).resolves.toBe("Before");
  expect(run).toHaveBeenCalledTimes(3);
});

test("new document creation preserves encoded title and explicit parent without a readback gate", async () => {
  let content = "";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[0] === "issues") return encode({ issue });
    if (args[1] === "create") {
      expect(args.slice(2, 6)).toEqual(["--issue", "ENG-12", "--title", "План & notes"]);
      content = await readFile(payloadFile(args), "utf8");
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content } });
  });
  const creation = parseTextAddress(
    "linear://example/issue/ENG-12/documents/new?title=%D0%9F%D0%BB%D0%B0%D0%BD%20%26%20notes",
  );
  if (creation?.kind !== "create-document") throw new Error("creation required");
  expect(await createLinearTextBackend(run).create(creation, "Saved", process.cwd())).toEqual({
    id,
    source: doc,
    url: `linear://example/document/${id}`,
  });
  expect(run).toHaveBeenCalledTimes(2);
});

test("acknowledged saves return the actual snapshot when Linear removes one final newline", async () => {
  let saved = "Before";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      saved = (await readFile(payloadFile(args), "utf8")).replace(/\n$/u, "");
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content: saved } });
  });
  expect(
    await createLinearTextBackend(run).save(address(doc), "Before", "Changed\n", process.cwd()),
  ).toBe("Changed");
  expect(run).toHaveBeenCalledTimes(3);
});

test.each([
  ["# Title\nParagraph.", "# Title\n\nParagraph."],
  ["ENG-12", "<issue>ENG-12</issue>"],
])("server transformations do not revoke an acknowledged save: %s", async (requested, saved) => {
  let content = "Before";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[1] === "update") {
      content = saved;
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content } });
  });
  await expect(
    createLinearTextBackend(run).save(address(doc), "Before", requested, process.cwd()),
  ).resolves.toBe(saved);
  expect(run.mock.calls.filter(([, args]) => args[1] === "update")).toHaveLength(1);
});
const diffId = "55e4fd09-d7ed-4356-a456-5d965a8cc7ba";
const prUrl = "https://github.com/example/repo/pull/162";
const prAppUrl = "https://linear.app/example/review/pull-request-258abca357fd";
const issueWidget = `<issue id="${id}" href="${issue.url}">ENG-12</issue>`;
const prWidget = `<pull-request id="${diffId}" href="${prAppUrl}">example/repo#162</pull-request>`;

// A real acknowledged save, followed by the backend's original normalized body.
function normalizedTransport(saved: string) {
  let content = "Before";
  return vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[0] === "issues") return encode({ issue: { ...issue, uuid: id } });
    if (args[0] === "resources") {
      const input: unknown = JSON.parse(await readFile(payloadFile(args), "utf8"));
      expect(args[2]).toBe("get_diff");
      expect(input).toEqual({ urlOrId: diffId });
      return encode({
        invocation: {
          workspace: "example",
          operation: "get_diff",
          effect: "applied",
          data: JSON.stringify({
            id: diffId,
            url: prUrl,
            appUrl: prAppUrl,
            fullIdentifier: "example/repo#162",
          }),
        },
      });
    }
    if (args[1] === "update") {
      content = saved;
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content } });
  });
}

test.each([
  ["checked boxes", "- [x] Finished\n", "* [X] Finished"],
  [
    "link brackets",
    "[Evidence](https://example.org/proof)",
    "[Evidence](<https://example.org/proof>)",
  ],
  ["issue mentions", "Continue with ENG-12.", `Continue with ${issueWidget}.`],
  ["pull request links", `[PR #162](${prUrl}) was merged.`, `${prWidget} was merged.`],
])("verified saves accept Linear %s without replaying the write", async (_name, wanted, saved) => {
  const run = normalizedTransport(saved);
  expect(
    await createLinearTextBackend(run).save(address(doc), "Before", wanted, process.cwd()),
  ).toBe(saved);
  expect(run.mock.calls.filter(([, args]) => args[1] === "update")).toHaveLength(1);
});

test("a writable resource reads the verified saved body, not its stale pre-save snapshot", async () => {
  const saved = "* [X] Finished";
  const resolver = createLinearTextResolver(createLinearTextBackend(normalizedTransport(saved)));
  const result = await resolver.tryResolve(doc, { cwd: process.cwd() });
  if (result.kind !== "resolved" || !result.resource.read || !result.resource.write)
    throw new Error("Missing writable resource");
  await result.resource.write([{ type: "text", text: "- [x] Finished" }], {});
  expect(await result.resource.read({})).toEqual([{ type: "text", text: saved }]);
});

test("transformed creation returns its acknowledged identity without warnings", async () => {
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[0] === "issues") return encode({ issue });
    if (args[1] === "create") return encode({ document: { id } });
    return encode({ document: { ...document, content: "* [X] Finished" } });
  });
  const creation = parseTextAddress("linear://example/issue/ENG-12/documents/new?title=Workpad");
  if (creation?.kind !== "create-document") throw new Error("Creation required");
  expect(
    await createLinearTextBackend(run).create(creation, "- [x] Finished", process.cwd()),
  ).toEqual({ id, source: doc, url: `linear://example/document/${id}` });
  expect(run.mock.calls.filter(([, args]) => args[1] === "create")).toHaveLength(1);
});

test("creation returns a stable Read link without checking final-newline normalization", async () => {
  let saved = "";
  const run = vi.fn<typeof runAxi>(async (_cwd, args) => {
    if (args[0] === "issues") return encode({ issue });
    if (args[1] === "create") {
      saved = (await readFile(payloadFile(args), "utf8")).replace(/\n$/u, "");
      return encode({ document: { id } });
    }
    return encode({ document: { ...document, content: saved } });
  });
  const creation = parseTextAddress("linear://example/issue/ENG-12/documents/new?title=Proof");
  if (creation?.kind !== "create-document") throw new Error("creation required");
  expect(await createLinearTextBackend(run).create(creation, "Saved\n", process.cwd())).toEqual({
    id,
    source: doc,
    url: `linear://example/document/${id}`,
  });
  expect(run).toHaveBeenCalledTimes(2);
});
test("new comment creation confirms a nested MCP list without replaying the mutation", async () => {
  const run = vi.fn<typeof runAxi>(async (_cwd, args) =>
    args[0] === "issues"
      ? encode({ issue })
      : args[1] === "create"
        ? encode({ comment: { id } })
        : encode({ comments: { comments: [{ id, body: "New comment" }], hasNextPage: false } }),
  );
  const creation = parseTextAddress("linear://example/issue/ENG-12/comments/new");
  if (creation?.kind !== "create-comment") throw new Error("creation required");
  expect(
    await createLinearTextBackend(run).create(creation, "New comment", process.cwd()),
  ).toMatchObject({
    id,
    source: `linear://example/issue/ENG-12/comment/${id}`,
  });
  expect(run.mock.calls.filter(([, args]) => args[1] === "create")).toHaveLength(1);
});
test("a nested comment list that is incomplete cannot establish absence", async () => {
  const run = vi.fn<typeof runAxi>(async (_cwd, args) =>
    args[0] === "issues"
      ? encode({ issue })
      : encode({ comments: { comments: [], hasNextPage: true } }),
  );
  await expect(
    createLinearTextBackend(run).readComment(
      `linear://example/issue/ENG-12/comment/${id}`,
      process.cwd(),
    ),
  ).rejects.toThrow("LINEAR_LOOKUP_INCOMPLETE");
});
test.each([false, true])(
  "created comment is verified through its parent context and remains read-only (nested=%s)",
  async (nested) => {
    const source = `linear://example/issue/ENG-12/comment/${id}`;
    const run = vi.fn<typeof runAxi>(async (_cwd, args) =>
      args[0] === "issues"
        ? encode({ issue })
        : encode({
            count: 1,
            comments: nested
              ? { comments: [{ id, body: "New comment" }], hasNextPage: false }
              : [{ id, body: "New comment" }],
          }),
    );
    const result = await createLinearTextResolver(createLinearTextBackend(run)).tryResolve(source, {
      cwd: process.cwd(),
    });
    if (result.kind !== "resolved" || !result.resource.read) throw new Error("missing comment");
    expect(await result.resource.read({})).toEqual([{ type: "text", text: "New comment" }]);
    expect(result.resource.write).toBeUndefined();
  },
);
