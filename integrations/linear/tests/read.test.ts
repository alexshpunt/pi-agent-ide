import { encode } from "@toon-format/toon-v4";
import { expect, test, vi } from "vitest";
import { createLinearResolver, parseIssueUrl } from "#linear/read.ts";
import { decodeDocument, decodeIssue } from "#linear/axi.ts";
import { parsePageUrl } from "#linear/urls.ts";

const source = "https://linear.app/example/issue/ENG-12/a-task";

test("native issue reads retain the safe stage code without exposing provider exception text", async () => {
  const code = "LINEAR_OPERATION_RATE_LIMITED";
  const resolved = await createLinearResolver(async () => {
    throw new Error(code);
  }).tryResolve(source, { cwd: process.cwd() });
  if (resolved.kind !== "resolved" || !resolved.resource.read) throw new Error("Missing resource");
  await expect(resolved.resource.read({})).rejects.toMatchObject({
    code,
    source,
    effect: "not-applied",
  });
});
const issue = {
  id: "ENG-12",
  uuid: "issue-uuid",
  title: "A task",
  url: source,
  description: 'First line\n\nSecond line with "quotes" and \\paths.',
  project: "Example project",
  team: "ENG",
  status: "In Progress",
};

test.each([
  ["https://linear.app/example-fixture/team/ENG/overview", "team-overview", "ENG"],
  ["https://linear.app/example-fixture/team/ENG/all", "team-issues", "ENG"],
  ["https://linear.app/example-fixture/team/ENG/projects/all", "team-projects", "ENG"],
  [
    "https://linear.app/example-fixture/project/sample-project-ab12cd34ef56/overview",
    "project",
    "ab12cd34ef56",
  ],
])("recognizes requested page %s", (url, kind, identifier) => {
  expect(parsePageUrl(url)).toMatchObject({
    workspace: "example-fixture",
    kind,
    identifier,
    source: url,
  });
});

test("keeps opaque continuation cursors in list resource identity", () => {
  const source = "https://linear.app/example-fixture/team/ENG/all?cursor=next%2Fpage";
  expect(parsePageUrl(source)).toMatchObject({ source, cursor: "next/page" });
  expect(() =>
    parsePageUrl("https://linear.app/example-fixture/team/ENG/overview?cursor=next"),
  ).toThrow("LINEAR_INVALID_URL");
  expect(() =>
    parsePageUrl("https://linear.app/example-fixture/team/ENG/all?unexpected=value"),
  ).toThrow("LINEAR_INVALID_URL");
});

test("recognizes Linear issue URLs without claiming other web pages", () => {
  expect(parseIssueUrl(source)).toEqual({ workspace: "example", identifier: "ENG-12", source });
  expect(parseIssueUrl("https://example.org/example/issue/ENG-12/a-task")).toBeUndefined();
});

test.each([
  "http://linear.app/example/issue/ENG-12/a-task",
  "https://user:password@linear.app/example/issue/ENG-12/a-task",
  "https://linear.app/example/project/project-id",
])("rejects unsupported owned URL %s without running a backend", async (url) => {
  const backend = vi.fn();
  const resolver = createLinearResolver(backend);
  const result = await resolver.tryResolve(url, { cwd: process.cwd() });
  expect(result.kind).toBe("failed");
  expect(backend).not.toHaveBeenCalled();
});

test("decodes a quoted issue title that starts with a version in brackets", () => {
  const titled = { ...issue, title: "[0.3] Remote SSH support: read/write resources" };
  expect(decodeIssue(encode({ issue: titled }), source)).toEqual(titled);
});

test("ignores AXI history fields that are not part of the Read result", () => {
  const output =
    encode({ issue }) +
    "\n  stateHistory[1]:\n    -\n      state:\n        name: Done\n      startedAt: 2026-10-01";
  expect(decodeIssue(output, source)).toEqual(issue);
});

test("shows attachments and stable document read links without fetching their content", async () => {
  const backend = vi.fn().mockResolvedValue({
    ...issue,
    attachments: [
      { id: "attachment-id", title: "A pull request", url: "https://example.org/pull/1" },
    ],
    documents: [{ id: "71000000-0000-4000-8000-000000000006", title: "Original request" }],
  });
  const resolved = await createLinearResolver(backend).tryResolve(source, { cwd: process.cwd() });
  if (resolved.kind !== "resolved" || !resolved.resource.read) throw new Error("Missing resource");
  const blocks = await resolved.resource.read({});
  const content = (blocks[0] as { text: string }).text;
  expect(content).toContain("linear://example/issue/ENG-12/description");
  expect(resolved.resource.write).toBeUndefined();
  expect(content).toContain("## Attachments (1)");
  expect(content).toContain("https://example.org/pull/1");
  expect(content).toContain("## Documents (1)");
  expect(content).toContain("linear://example/document/71000000-0000-4000-8000-000000000006");
  expect(backend).toHaveBeenCalledTimes(1);
});

test("reads both stable and native document links as read-only content", async () => {
  const id = "71000000-0000-4000-8000-000000000006";
  const document = {
    id,
    title: "Original request",
    url: "https://linear.app/example/document/original-request-1234abcd5678",
    content: "Full document\n\nLast line",
  };
  const readDocument = vi.fn().mockResolvedValue(document);
  for (const link of [`linear://example/document/${id}`, document.url]) {
    const resolved = await createLinearResolver(vi.fn(), readDocument).tryResolve(link, {
      cwd: process.cwd(),
    });
    if (resolved.kind !== "resolved" || !resolved.resource.read)
      throw new Error("Missing document");
    expect(resolved.resource.write).toBeUndefined();
    const blocks = await resolved.resource.read({});
    expect(blocks).toHaveLength(1);
    const block = blocks.at(0);
    const content = block?.type === "text" ? block.text : undefined;
    expect(content).toContain(`linear://example/document/${id}/content`);
    expect(content).toContain(document.content);
  }
});
test("decodes multiline CLI descriptions without rendering TOON escapes", () => {
  expect(decodeIssue(encode({ issue }), source)).toEqual(issue);
});

test("keeps both linked collections and rejects truncated or unsafe attachments", () => {
  const linked = {
    ...issue,
    attachments: [{ id: "attachment", title: "A PR", url: "https://example.org/pull/1" }],
    documents: [{ id: "71000000-0000-4000-8000-000000000006", title: "A document" }],
  };
  expect(decodeIssue(encode({ issue: linked }), source)).toEqual(linked);
  expect(() => decodeIssue(encode({ issue }) + "\n  documents[1]{id,title}:\n", source)).toThrow(
    "LINEAR_INVALID_RESPONSE",
  );
  expect(() =>
    decodeIssue(
      encode({
        issue: {
          ...linked,
          attachments: [{ id: "attachment", title: "Unsafe", url: "javascript:alert(1)" }],
        },
      }),
      source,
    ),
  ).toThrow("LINEAR_INVALID_RESPONSE");
});

test("checks document workspace and UUID or slug before returning content", () => {
  const id = "71000000-0000-4000-8000-000000000006";
  const native = "https://linear.app/example/document/request-1234abcd5678";
  const document = { id, title: "Request", url: native, content: "Full content" };
  const output = encode({ document });
  expect(decodeDocument(output, native)).toEqual(document);
  expect(decodeDocument(output, `linear://example/document/${id}`)).toEqual(document);
  expect(() => decodeDocument(output, `linear://other/document/${id}`)).toThrow(
    "LINEAR_IDENTITY_MISMATCH",
  );
  expect(() => decodeDocument(output, native.replace("1234abcd5678", "000000000000"))).toThrow(
    "LINEAR_IDENTITY_MISMATCH",
  );
  expect(() =>
    decodeDocument(output, `linear://example/document/${id.replace("1ee82829", "00000000")}`),
  ).toThrow("LINEAR_IDENTITY_MISMATCH");
});

test.each([
  "linear://user:secret@example/document/71000000-0000-4000-8000-000000000006",
  "linear://example/document/not-a-uuid",
  "https://linear.app/example/document/no-document-id",
])("rejects invalid document location %s without backend access", async (url) => {
  const backend = vi.fn();
  const result = await createLinearResolver(backend, backend).tryResolve(url, {
    cwd: process.cwd(),
  });
  expect(result.kind).toBe("failed");
  expect(backend).not.toHaveBeenCalled();
});

test("refuses a returned issue from another workspace", () => {
  expect(() =>
    decodeIssue(encode({ issue: { ...issue, url: source.replace("example", "other") } }), source),
  ).toThrow("LINEAR_IDENTITY_MISMATCH");
});

test("reads a fresh issue on every call and provides only read access", async () => {
  const backend = vi
    .fn()
    .mockResolvedValueOnce(issue)
    .mockResolvedValueOnce({ ...issue, description: "Changed" });
  const resolved = await createLinearResolver(backend).tryResolve(source, { cwd: process.cwd() });
  expect(resolved.kind).toBe("resolved");
  if (resolved.kind !== "resolved" || !resolved.resource.read) throw new Error("Missing resource");
  expect(resolved.resource.write).toBeUndefined();
  const first = await resolved.resource.read({});
  const second = await resolved.resource.read({});
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  const before = first.at(0);
  const after = second.at(0);
  const beforeText = before?.type === "text" ? before.text : undefined;
  expect(beforeText).toContain(issue.description);
  expect(beforeText).toContain("Example project");
  expect(after?.type === "text" && after.text).toContain("Changed");
  expect(backend).toHaveBeenCalledTimes(2);
});

test("does not start a read after cancellation", async () => {
  const backend = vi.fn();
  const resolved = await createLinearResolver(backend).tryResolve(source, { cwd: process.cwd() });
  if (resolved.kind !== "resolved" || !resolved.resource.read) throw new Error("Missing resource");
  const controller = new AbortController();
  controller.abort();
  await expect(resolved.resource.read({ signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(backend).not.toHaveBeenCalled();
});

test("keeps backend secrets and raw transport errors out of resource failures", async () => {
  const backend = vi.fn().mockRejectedValue(new Error("Bearer private-token"));
  const resolved = await createLinearResolver(backend).tryResolve(source, { cwd: process.cwd() });
  if (resolved.kind !== "resolved" || !resolved.resource.read) throw new Error("Missing resource");
  await expect(resolved.resource.read({})).rejects.toThrow("LINEAR_READ_FAILED");
  await expect(resolved.resource.read({})).rejects.not.toThrow("private-token");
});
