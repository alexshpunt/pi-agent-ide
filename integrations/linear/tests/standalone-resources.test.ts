import { expect, test, vi } from "vitest";
import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { createStandaloneResources } from "#linear/standalone-resources.ts";

const source = "linear://example/document/11111111-1111-4111-8111-111111111111/content";
const context = { cwd: "/fixture" };
function fixture(initial = "First line\nSecond line\nThird line\n") {
  let stored = initial;
  const write = vi.fn(async (text: string) => {
    stored = text;
  });
  const resolver: ResourceResolver = {
    id: "fixture",
    async tryResolve(path) {
      if (path !== source) return { kind: "not-handled" };
      const expected = stored;
      return {
        kind: "resolved",
        resource: {
          source,
          read: async () => [{ type: "text", text: expected }],
          write: async (blocks) => {
            if (stored !== expected)
              throw new ResourceError("LINEAR_STALE_CONTENT", source, "not-applied");
            await write(
              blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
            );
          },
        },
      };
    },
  };
  const host = createStandaloneResources({
    resolvers: [resolver],
    write: [],
    insert: [],
    fileOperations: [],
    guides: [],
  });
  return {
    host,
    write,
    get content() {
      return stored;
    },
    set content(value: string) {
      stored = value;
    },
  };
}

test.each([
  [{ anchor: "end" }, { after: "end" }],
  [{ anchor: "end", before: false }, { after: "end" }],
  [{ anchor: "end", before: true }, { before: "end" }],
  [{ before: true }, { before: "" }],
  [{}, {}],
])("standalone normalizes semantic insertion %j", async (selectors, expected) => {
  const path = "linear://example/issue/ENG-12#attachments";
  const matches = vi.fn(() => true);
  const execute = vi.fn(async () => ({ source: path, summary: "Applied", data: {} }));
  const host = createStandaloneResources({
    resolvers: [],
    write: [],
    insert: [{ matches, execute }],
    fileOperations: [],
    guides: [],
  });
  const input = { path, text: "file:archive.zip", ...selectors };
  const semanticInput = { path, text: input.text, ...expected };
  await host.mutate("insert", input, context);
  expect(matches).toHaveBeenCalledWith(semanticInput);
  expect(execute).toHaveBeenCalledWith(expect.anything(), semanticInput);
});

test("standalone writes need no prior read", async () => {
  const f = fixture();
  await f.host.mutate("write", { path: source, content: "Changed" }, context);
  expect(f.content).toBe("Changed");
  await f.host.mutate("write", { path: source, content: "Again" }, context);
  expect(f.content).toBe("Again");
  expect(f.write).toHaveBeenCalledTimes(2);
});

test("a partial Read gives anchors and does not limit later edits", async () => {
  const f = fixture();
  const read = await f.host.read(
    { path: source, offset: 2, limit: 1, views: ["anchors"] },
    context,
  );
  const anchor = read.content[0].type === "text" ? read.content[0].text.split(" ")[0] : "";
  expect(anchor).toMatch(/^2#[A-F0-9]{8}$/u);
  await f.host.mutate("replace", { path: source, start: anchor, text: "New second" }, context);
  expect(f.content).toBe("First line\nNew second\nThird line\n");
  await f.host.mutate(
    "replace",
    { path: source, start: "First line", text: "Other first" },
    context,
  );
  expect(f.content).toBe("Other first\nNew second\nThird line\n");
});

test.each(["\ud83e", "\r"])(
  "text selectors cannot split a code point or CRLF (%j)",
  async (selector) => {
    const f = fixture("Hello 🦊\r\nNext");
    await f.host.read({ path: source }, context);
    await expect(
      f.host.mutate("replace", { path: source, start: selector, text: "" }, context),
    ).rejects.toMatchObject({ code: "LINEAR_INVALID_TEXT_BOUNDARY" });
    expect(f.write).not.toHaveBeenCalled();
  },
);
test("exact body replacements do not widen into adjacent text", async () => {
  const f = fixture();
  await f.host.read({ path: source }, context);
  await f.host.mutate("replace", { path: source, start: "Second", text: "Other" }, context);
  expect(f.content).toBe("First line\nOther line\nThird line\n");
});

test("insertion uses complete observed lines and preserves CRLF", async () => {
  const f = fixture("First\r\nSecond\r\n");
  await f.host.read({ path: source }, context);
  await f.host.mutate("insert", { path: source, anchor: "First", text: "Added" }, context);
  expect(f.content).toBe("First\r\nAdded\r\nSecond\r\n");
});

test("whole-line deletion keeps adjacent unselected lines", async () => {
  const f = fixture();
  await f.host.read({ path: source }, context);
  await f.host.mutate("delete", { path: source, start: "Second", end: "Second" }, context);
  expect(f.content).toBe("First line\nThird line\n");
});

test("a search does not limit later edits", async () => {
  const f = fixture();
  await f.host.search({ path: source, query: "Second" }, context);
  await f.host.mutate("replace", { path: source, start: "Second", text: "Found" }, context);
  expect(f.content).toBe("First line\nFound line\nThird line\n");
});

test("an unknown semantic mutation retains its outcome", async () => {
  const f = fixture();
  const handler = {
    matches: () => true,
    execute: vi.fn(async () => {
      throw new ResourceError("LINEAR_DELIVERY_UNKNOWN", source, "unknown");
    }),
  };
  const resolver: ResourceResolver = {
    id: "fixture",
    tryResolve: async () => ({
      kind: "resolved",
      resource: { source, read: async () => [{ type: "text", text: f.content }] },
    }),
  };
  const host = createStandaloneResources({
    resolvers: [resolver],
    write: [handler],
    insert: [],
    fileOperations: [],
    guides: [],
  });
  await host.read({ path: source }, context);
  await expect(
    host.mutate("write", { path: source, content: "Unknown" }, context),
  ).rejects.toMatchObject({ effect: "unknown" });
  expect(handler.execute).toHaveBeenCalledOnce();
});

test("unowned addresses never fall through to local files", async () => {
  const f = fixture();
  await expect(f.host.read({ path: "/tmp/private" }, context)).rejects.toMatchObject({
    code: "LINEAR_INVALID_URL",
  });
  expect(f.write).not.toHaveBeenCalled();
});
