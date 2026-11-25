import { expect, test } from "vitest";
import { parseTextAddress } from "#linear/text-address.ts";

const document = "71000000-0000-4000-8000-000000000006";
const project = "71000000-0000-4000-8000-000000000002";

test.each([
  [`linear://example/document/${document}/content`, "document-content", document],
  ["linear://example/issue/ENG-12/description", "issue-description", "ENG-12"],
  [`linear://example/project/${project}/description`, "project-description", project],
])("addresses only the editable body of %s", (source, kind, identifier) => {
  expect(parseTextAddress(source)).toMatchObject({
    source,
    workspace: "example",
    kind,
    identifier,
  });
});

test("creates a document under an explicit parent with an encoded title", () => {
  const source =
    "linear://example/issue/ENG-12/documents/new?title=" + encodeURIComponent("План & scope");
  expect(parseTextAddress(source)).toMatchObject({
    workspace: "example",
    kind: "create-document",
    parentKind: "issue",
    identifier: "ENG-12",
    title: "План & scope",
  });
  expect(
    parseTextAddress(`linear://example/project/${project}/documents/new?title=Workpad`),
  ).toMatchObject({
    kind: "create-document",
    parentKind: "project",
    identifier: project,
    title: "Workpad",
  });
});

test("creates a comment without a title or implicit parent", () => {
  expect(parseTextAddress("linear://example/issue/ENG-12/comments/new")).toMatchObject({
    kind: "create-comment",
    workspace: "example",
    identifier: "ENG-12",
  });
});

test.each([
  "linear://example/issue/ENG-12/documents/new",
  "linear://example/issue/ENG-12/documents/new?title=",
  "linear://example/issue/ENG-12/documents/new?title=A&title=B",
  "linear://example/issue/ENG-12/documents/new?title=A&project=other",
  "linear://example/issue/ENG-12/comments/new?title=A",
  "linear://user:secret@example/issue/ENG-12/comments/new",
  `linear://example/document/${document}/content?unexpected=1`,
  "linear://example/issue/not-an-id/description",
  "linear://example/project/not-an-id/description",
])("rejects malformed mutation address %s", (source) => {
  expect(() => parseTextAddress(source)).toThrow("LINEAR_INVALID_URL");
});

test.each([
  "https://example.org/page",
  "https://linear.app/example/issue/ENG-12/a-task",
  `linear://example/document/${document}`,
  "linear://example/search/issues?term=SSH",
])("does not claim another read resource %s", (source) => {
  expect(parseTextAddress(source)).toBeUndefined();
});
