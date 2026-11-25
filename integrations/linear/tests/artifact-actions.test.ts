import { required } from "./fixtures/check.ts";
import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  createLinearArtifactBackend,
  type ArtifactBackendOptions,
  type ArtifactOperationBackend,
} from "#linear/artifact-backend.ts";
import {
  createLinearArtifactHandlers,
  createLinearArtifactResolver,
  parseArtifactFileInput,
  parseArtifactResource,
} from "#linear/artifact-actions.ts";

const documentId = "71000000-0000-4000-8000-000000000006";
const issueId = "f338bffe-9819-4df4-aba8-94b53a290fad";
const oldId = "db467bae-7006-423f-a331-7fe02861983c";
const newId = "f78aabbd-4b84-491d-a2ed-46c1f971bf0e";
const oldAsset = "https://uploads.linear.app/workspace/old/file";
const newAsset = "https://uploads.linear.app/workspace/new/file";
const issueUrl = "https://linear.app/example/issue/ENG-12/fixture";
const documentUrl = "https://linear.app/example/document/original-request-1234abcd5678";
const projectId = "8d7437d5-adc6-4d0b-bce3-1e7af6196ecc";
const projectUrl = "https://linear.app/example/project/fixture-ab12cd34ef56/overview";
const bytes = Buffer.from([0x50, 0x4b, 3, 4, 255, 0]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const uploadReceipt = {
  workspace: "example",
  upload: "applied" as const,
  filename: "new.zip",
  size: bytes.length,
  sha256,
  assetUrl: newAsset,
  read: `linear://example/asset?url=${encodeURIComponent(newAsset)}`,
  attachment: { effect: "applied" as const, id: newId, url: newAsset },
};

function fixture() {
  const document = {
    id: documentId,
    title: "Original",
    content: "Unchanged body",
    url: documentUrl,
    issueId,
  };
  const old = { id: oldId, title: "Archive", url: oldAsset, issueId };
  const project = {
    id: "P-ENG-123",
    uuid: projectId,
    name: "Project fixture",
    url: projectUrl,
    resources: [{ id: oldId, title: "Existing resource", url: oldAsset }] as Array<
      Record<string, unknown>
    >,
    resourceCount: 1,
  };
  const issue = {
    id: issueId,
    identifier: "ENG-12",
    title: "Fixture",
    url: issueUrl,
    attachments: [old] as Array<Record<string, unknown>>,
  };
  const invoke = vi.fn<ArtifactOperationBackend["invoke"]>(async (_workspace, operation, input) => {
    let data: unknown;
    if (operation === "get_document") data = { ...document };
    else if (operation === "save_document") {
      document.title = String(input.title);
      data = { ...document };
    } else if (operation === "get_attachment") data = { ...old };
    else if (operation === "get_issue") data = structuredClone(issue);
    else if (operation === "get_project") data = structuredClone(project);
    else if (operation === "save_project") {
      const link = required((input.links as readonly Readonly<Record<string, unknown>>[])[0]);
      // MCP returns project links with label, while document resources use title.
      project.resources.push({ id: newId, label: link.title, url: link.url });
      project.resourceCount = project.resources.length;
      data = structuredClone(project);
    } else if (operation === "save_issue") {
      const link = required((input.links as readonly Readonly<Record<string, unknown>>[])[0]);
      issue.attachments.push({ id: newId, title: link.title, url: link.url, issueId });
      data = structuredClone(issue);
    } else if (operation === "delete_attachment") {
      issue.attachments = issue.attachments.filter((item) => item.id !== input.id);
      data = { success: true };
    } else throw new Error("Unexpected operation");
    return { workspace: "example", operation, effect: "applied" as const, data };
  });
  const upload = vi.fn<NonNullable<ArtifactBackendOptions["upload"]>>(async () => {
    issue.attachments.push({ id: newId, title: "Archive", url: newAsset, issueId });
    return uploadReceipt;
  });
  const readBytes = vi.fn(async () => bytes);
  return {
    document,
    issue,
    old,
    project,
    invoke,
    upload,
    readBytes,
    backend: createLinearArtifactBackend({ invoke }, { upload, readBytes }),
  };
}

test("Move changes only a document title and returns the same canonical identity", async () => {
  const fixture = fixtureWithHandlers();
  const result = await fixture.handlers.fileOperations(
    "move",
    {
      path: `linear://example/document/${documentId}`,
      target: `linear://example/document/${documentId}?title=${encodeURIComponent("Новая заметка")}`,
    },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({
    ok: true,
    effect: "applied",
    path: `linear://example/document/${documentId}`,
    target: `linear://example/document/${documentId}`,
  });
  expect(fixture.document).toMatchObject({
    id: documentId,
    content: "Unchanged body",
    issueId,
    title: "Новая заметка",
  });
  expect(fixture.invoke.mock.calls.filter((call) => call[1] === "save_document")).toEqual([
    [
      "example",
      "save_document",
      { id: documentId, title: "Новая заметка" },
      process.cwd(),
      undefined,
    ],
  ]);
});

function fixtureWithHandlers() {
  const state = fixture();
  return { ...state, handlers: createLinearArtifactHandlers(state.backend) };
}

test.each([
  [{ after: "end" }, true],
  [{}, true],
  [{ after: "start" }, false],
  [{ before: "end" }, false],
] as const)("attachment insertion checks the boundary %j", async (selectors, applied) => {
  const state = fixtureWithHandlers();
  const path = `${issueUrl}#attachments`;
  const input = { path, text: "file:archive.zip", ...selectors };
  const handler = state.handlers.insert;
  const result = handler.execute({ cwd: process.cwd() } as never, input);
  if (applied) {
    await result;
    expect(state.upload).toHaveBeenCalledTimes(1);
  } else {
    await expect(result).rejects.toMatchObject({ code: "LINEAR_INVALID_ATTACHMENT_INSERT" });
    expect(state.upload).not.toHaveBeenCalled();
  }
});

test("document rename refuses a different identity or workspace before dispatch", async () => {
  const state = fixtureWithHandlers();
  for (const target of [
    `linear://other/document/${documentId}?title=Other`,
    `linear://example/document/${newId}?title=Other`,
  ]) {
    const result = await state.handlers.fileOperations(
      "move",
      { path: `linear://example/document/${documentId}`, target },
      { cwd: process.cwd() },
    );
    expect(result).toMatchObject({ ok: false, effect: "not-applied" });
  }
  expect(state.invoke).not.toHaveBeenCalled();
});

test("Copy adds the same document link to the destination without upload or reparenting", async () => {
  const state = fixtureWithHandlers();
  const result = await state.handlers.fileOperations(
    "copy",
    {
      path: `linear://example/document/${documentId}`,
      target: `${issueUrl}#attachments`,
    },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: true, effect: "applied" });
  expect(state.issue.attachments).toEqual(
    expect.arrayContaining([expect.objectContaining({ url: documentUrl, title: "Original" })]),
  );
  expect(state.document).toMatchObject({ issueId, content: "Unchanged body" });
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.readBytes).not.toHaveBeenCalled();
  expect(state.invoke.mock.calls.some((call) => call[1] === "save_document")).toBe(false);
});

test("Copy accepts a document body resource while linking its native document identity", async () => {
  const state = fixtureWithHandlers();
  const result = await state.handlers.fileOperations(
    "copy",
    { path: `linear://example/document/${documentId}/content`, target: `${issueUrl}#attachments` },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: true, effect: "applied" });
  expect(state.issue.attachments.some((row) => row.url === documentUrl)).toBe(true);
  expect(state.upload).not.toHaveBeenCalled();
});

test("project Copy recognizes an existing reference and makes no duplicate upload or save", async () => {
  const state = fixtureWithHandlers();
  const result = await state.handlers.fileOperations(
    "copy",
    { path: oldAsset, target: `${projectUrl}#attachments` },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: true, effect: "applied" });
  expect(state.project.resources).toHaveLength(1);
  expect(state.invoke.mock.calls.some((call) => call[1].startsWith("save_"))).toBe(false);
  expect(state.upload).not.toHaveBeenCalled();
});

test("project Copy never repeats an uncertain save", async () => {
  const state = fixtureWithHandlers();
  const original = required(state.invoke.getMockImplementation());
  state.invoke.mockImplementation(async (...args) =>
    args[1] === "save_project"
      ? {
          workspace: "example",
          operation: args[1],
          effect: "unknown",
          error: "LINEAR_RESOURCE_FAILED",
        }
      : original(...args),
  );
  const result = await state.handlers.fileOperations(
    "copy",
    { path: documentUrl, target: `${projectUrl}#attachments` },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: false, effect: "unknown" });
  expect(state.invoke.mock.calls.filter((call) => call[1] === "save_project")).toHaveLength(1);
  expect(state.upload).not.toHaveBeenCalled();
});
test("Copy adds a document reference to a project without reparenting or uploading it", async () => {
  const state = fixtureWithHandlers();
  const result = await state.handlers.fileOperations(
    "copy",
    { path: `linear://example/document/${documentId}`, target: `${projectUrl}#attachments` },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({
    ok: true,
    effect: "applied",
    target: `linear://example/project/${projectId}#attachments`,
  });
  expect(state.project.resources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: "Existing resource", url: oldAsset }),
      expect.objectContaining({ label: "Original", url: documentUrl }),
    ]),
  );
  expect(state.document).toMatchObject({ issueId, content: "Unchanged body" });
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.readBytes).not.toHaveBeenCalled();
  expect(state.invoke.mock.calls.filter((call) => call[1] === "save_project")).toEqual([
    [
      "example",
      "save_project",
      { id: projectId, links: [{ url: documentUrl, title: "Original" }] },
      process.cwd(),
      undefined,
    ],
  ]);
});

test("a failed project-link verification stays unknown after one acknowledged save", async () => {
  for (const failure of ["read", "lost-original"]) {
    const state = fixtureWithHandlers();
    const original = required(state.invoke.getMockImplementation());
    let saved = false;
    state.invoke.mockImplementation(async (...args) => {
      if (saved && args[1] === "get_project" && failure === "read")
        return {
          workspace: "example",
          operation: args[1],
          effect: "not-applied",
          error: "LINEAR_RESOURCE_FAILED",
        };
      const result = await original(...args);
      if (args[1] === "save_project") {
        saved = true;
        if (failure === "lost-original") {
          state.project.resources = state.project.resources.filter((row) => row.id !== oldId);
          state.project.resourceCount = state.project.resources.length;
        }
      }
      return result;
    });
    const result = await state.handlers.fileOperations(
      "copy",
      { path: documentUrl, target: `${projectUrl}#attachments` },
      { cwd: process.cwd() },
    );
    expect(result).toMatchObject({ ok: false, effect: "unknown" });
    expect(state.invoke.mock.calls.filter((call) => call[1] === "save_project")).toHaveLength(1);
    expect(state.upload).not.toHaveBeenCalled();
  }
});

test("an unrelated project or missing resource list refuses before linking", async () => {
  for (const failure of ["identity", "resources"]) {
    const state = fixtureWithHandlers();
    if (failure === "identity") state.project.uuid = newId;
    else state.project.resourceCount = 42;
    const result = await state.handlers.fileOperations(
      "copy",
      { path: documentUrl, target: `linear://example/project/${projectId}#attachments` },
      { cwd: process.cwd() },
    );
    expect(result).toMatchObject({ ok: false, effect: "not-applied" });
    expect(state.invoke.mock.calls.some((call) => call[1] === "save_project")).toBe(false);
    expect(state.upload).not.toHaveBeenCalled();
  }
});

test("project resource Read is lazy and strips only private storage signatures", async () => {
  const state = fixture();
  required(state.project.resources[0]).url = `${oldAsset}?signature=private`;
  const resolved = await createLinearArtifactResolver(state.backend).tryResolve(
    `${projectUrl}#attachments`,
    { cwd: process.cwd() },
  );
  if (resolved.kind !== "resolved" || !resolved.resource.read)
    throw new Error("Missing project resource collection");
  const card = JSON.stringify(await resolved.resource.read({}));
  expect(card).toContain(`linear://example/project/${projectId}#attachments`);
  expect(card).toContain("Existing resource");
  expect(card).not.toContain("signature");
  expect(state.invoke.mock.calls).toEqual([
    [
      "example",
      "get_project",
      { query: "fixture-ab12cd34ef56", includeResources: true },
      process.cwd(),
      undefined,
    ],
  ]);
  expect(state.readBytes).not.toHaveBeenCalled();
  expect(resolved.resource.write).toBeUndefined();
});

test("a local file Insert on a project refuses rather than claiming issue-only upload support", async () => {
  const state = fixture();
  await expect(
    state.backend.insert(
      {
        workspace: "example",
        kind: "project",
        identifier: projectId,
        source: `${projectUrl}#attachments`,
      },
      { file: "/tmp/new.zip" },
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_ATTACHMENT_PARENT_UNSUPPORTED", effect: "not-applied" });
  expect(state.invoke).not.toHaveBeenCalled();
  expect(state.upload).not.toHaveBeenCalled();
});
test("Insert uploads an explicit local file and leaves existing attachment and source file alone", async () => {
  const state = fixture();
  const result = await state.backend.insert(
    {
      workspace: "example",
      kind: "issue",
      identifier: "ENG-12",
      source: `${issueUrl}#attachments`,
    },
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result).toMatchObject({
    effect: "applied",
    upload: { sha256, attachment: { id: newId } },
  });
  expect(state.upload).toHaveBeenCalledWith(
    { file: "/tmp/new.zip", workspace: "example", issue: "ENG-12" },
    process.cwd(),
    undefined,
  );
  expect(state.issue.attachments.some((item) => item.id === oldId)).toBe(true);
  expect(state.invoke.mock.calls.some((call) => call[1] === "delete_attachment")).toBe(false);
});

test("replacement verifies original bytes and new attachment before removing only the old card link", async () => {
  const state = fixture();
  const result = await state.backend.replace(
    "example",
    oldId,
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result).toMatchObject({
    effect: "applied",
    upload: { assetUrl: newAsset },
    removal: { effect: "applied", id: oldId },
    oldAssetUrl: oldAsset,
  });
  expect(state.readBytes).toHaveBeenCalledWith(uploadReceipt.read, process.cwd(), undefined);
  expect(state.issue.attachments.map((item) => item.id)).toEqual([newId]);
  const operations = state.invoke.mock.calls.map((call) => call[1]);
  expect(operations.at(-2)).toBe("delete_attachment");
  expect(operations.at(-1)).toBe("get_issue");
  expect(operations.filter((item) => item === "delete_attachment")).toHaveLength(1);
});

test("an uncertain upload retains the old attachment and is never replayed", async () => {
  const state = fixture();
  state.upload.mockImplementationOnce(async () => ({
    ...uploadReceipt,
    upload: "unknown",
    attachment: { effect: "unknown", id: newId, url: newAsset },
  }));
  const result = await state.backend.replace(
    "example",
    oldId,
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result).toMatchObject({
    effect: "unknown",
    upload: { read: uploadReceipt.read },
    removal: { effect: "not-applied" },
  });
  expect(state.upload).toHaveBeenCalledTimes(1);
  expect(state.readBytes).not.toHaveBeenCalled();
  expect(state.invoke.mock.calls.some((call) => call[1] === "delete_attachment")).toBe(false);
});

test("byte mismatch or concurrent old-link change refuses removal and retains the completed upload", async () => {
  for (const concurrent of [false, true]) {
    const state = fixture();
    if (concurrent)
      state.readBytes.mockImplementationOnce(async () => {
        state.old.url = "https://example.org/changed";
        required(state.issue.attachments[0]).url = state.old.url;
        return bytes;
      });
    else state.readBytes.mockResolvedValueOnce(Buffer.from("not the uploaded bytes"));
    const result = await state.backend.replace(
      "example",
      oldId,
      { file: "/tmp/new.zip" },
      process.cwd(),
    );
    expect(result).toMatchObject({
      effect: "unknown",
      upload: { assetUrl: newAsset },
      removal: { effect: "not-applied" },
    });
    expect(result.error).toMatch(/^LINEAR_/);
    expect(state.issue.attachments.some((item) => item.id === oldId)).toBe(true);
    expect(state.invoke.mock.calls.some((call) => call[1] === "delete_attachment")).toBe(false);
  }
});

test("uncertain removal preserves both phase receipts and never repeats deletion", async () => {
  const state = fixture();
  const original = required(state.invoke.getMockImplementation());
  state.invoke.mockImplementation(async (...args) =>
    args[1] === "delete_attachment"
      ? {
          workspace: "example",
          operation: args[1],
          effect: "unknown",
          data: undefined,
          error: "LINEAR_RESOURCE_FAILED",
        }
      : original(...args),
  );
  const result = await state.backend.replace(
    "example",
    oldId,
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result).toMatchObject({
    effect: "unknown",
    upload: { read: uploadReceipt.read },
    removal: { effect: "unknown", id: oldId },
  });
  expect(state.invoke.mock.calls.filter((call) => call[1] === "delete_attachment")).toHaveLength(1);
});

test("external Copy does not fetch the URL or forward credentials; embedded credentials are rejected", async () => {
  const state = fixtureWithHandlers();
  const result = await state.handlers.fileOperations(
    "copy",
    { path: "https://example.org/report.pdf", target: `${issueUrl}#attachments` },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: true, effect: "applied" });
  expect(state.readBytes).not.toHaveBeenCalled();
  expect(state.upload).not.toHaveBeenCalled();
  const denied = await state.handlers.fileOperations(
    "copy",
    { path: "https://user:secret@example.org/file", target: `${issueUrl}#attachments` },
    { cwd: process.cwd() },
  );
  expect(denied).toMatchObject({ ok: false, effect: "not-applied" });
});

test("artifact addresses and descriptors refuse invalid scopes before executing", () => {
  expect(parseArtifactResource(`linear://example/attachment/${oldId}#file`)).toMatchObject({
    kind: "attachment-file",
    identifier: oldId,
  });
  expect(parseArtifactResource(`${issueUrl}#attachments`)).toMatchObject({
    kind: "attachments",
    identifier: "ENG-12",
  });
  expect(parseArtifactResource("https://example.org/#attachments")).toBeUndefined();
  expect(() =>
    parseArtifactResource(`linear://example/attachment/${oldId}?token=secret#file`),
  ).toThrow("LINEAR_INVALID_URL");
});

test("artifact metadata Read provides scoped identities, never signed credentials or byte edit access", async () => {
  const state = fixture();
  state.old.url = `${oldAsset}?signature=private`;
  const resolver = createLinearArtifactResolver(state.backend);
  const collection = await resolver.tryResolve(`${issueUrl}#attachments`, { cwd: process.cwd() });
  expect(collection.kind).toBe("resolved");
  if (collection.kind !== "resolved" || !collection.resource.read)
    throw new Error("Missing artifact collection");
  const card = JSON.stringify(await collection.resource.read({}));
  expect(card).toContain(`attachment/${oldId}?issue=ENG-12#file`);
  expect(card).not.toContain("signature");
  expect(collection.resource.write).toBeUndefined();
  const attachment = await resolver.tryResolve(
    `linear://example/attachment/${oldId}?issue=ENG-12#file`,
    { cwd: process.cwd() },
  );
  if (attachment.kind !== "resolved" || !attachment.resource.read)
    throw new Error("Missing attachment");
  const metadata = JSON.stringify(await attachment.resource.read({}));
  expect(metadata).toContain("Archive");
  expect(metadata).not.toContain("signature");
  expect(attachment.resource.readBytes).toBeUndefined();
  expect(state.upload).not.toHaveBeenCalled();
  expect(
    state.invoke.mock.calls.some(
      (call) => call[1].startsWith("save_") || call[1].startsWith("delete_"),
    ),
  ).toBe(false);
});

test("file descriptors accept local references and reject raw binary or unexpected fields", () => {
  const archive = "/tmp/archive.zip";
  const file = `file:${archive}`;
  expect(parseArtifactFileInput(file)).toEqual({
    file,
  });
  expect(
    parseArtifactFileInput('{"file":"/tmp/archive.zip","issue":"ENG-12","title":"Archive"}'),
  ).toMatchObject({ file: "/tmp/archive.zip", issue: "ENG-12" });
  for (const value of [
    "PK\\u0000\\u0003",
    '{"file":"/tmp/archive.zip","bytes":"secret"}',
    '{"file":42}',
  ])
    expect(() => parseArtifactFileInput(value)).toThrow("LINEAR_INVALID_FILE_REFERENCE");
});
test("native document source can rename through its canonical UUID target", async () => {
  const state = fixtureWithHandlers();
  const result = await state.handlers.fileOperations(
    "move",
    { path: documentUrl, target: `linear://example/document/${documentId}?title=Renamed` },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: true, target: `linear://example/document/${documentId}` });
  expect(state.document.title).toBe("Renamed");
});

test("replacement returns the new attachment identity rather than the removed resource", async () => {
  const state = fixture();
  const result = await state.backend.replace(
    "example",
    oldId,
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result.source).toBe(`linear://example/attachment/${newId}?issue=ENG-12#file`);
  expect(result.id).toBe(newId);
});

test("attachment metadata without its parent requires an explicit verified issue", async () => {
  const state = fixture();
  const { issueId: _parent, ...metadata } = state.old;
  state.invoke.mockImplementationOnce(async (_workspace, operation) => ({
    workspace: "example",
    operation,
    effect: "applied",
    data: metadata,
  }));
  await expect(
    state.backend.replace("example", oldId, { file: "/tmp/new.zip" }, process.cwd()),
  ).rejects.toMatchObject({ code: "LINEAR_ATTACHMENT_PARENT_REQUIRED", effect: "not-applied" });
  expect(state.upload).not.toHaveBeenCalled();
  state.invoke.mockImplementationOnce(async (_workspace, operation) => ({
    workspace: "example",
    operation,
    effect: "applied",
    data: metadata,
  }));
  expect(
    await state.backend.replace(
      "example",
      oldId,
      { file: "/tmp/new.zip", issue: "ENG-12" },
      process.cwd(),
    ),
  ).toMatchObject({ effect: "applied" });
});

test("an acknowledged removal followed by a failed verification stays uncertain", async () => {
  const state = fixture();
  const original = required(state.invoke.getMockImplementation());
  let deleted = false;
  state.invoke.mockImplementation(async (...args) => {
    if (deleted && args[1] === "get_issue")
      return {
        workspace: "example",
        operation: args[1],
        effect: "not-applied",
        error: "LINEAR_RESOURCE_FAILED",
      };
    const result = await original(...args);
    if (args[1] === "delete_attachment") deleted = true;
    return result;
  });
  const result = await state.backend.replace(
    "example",
    oldId,
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result).toMatchObject({
    effect: "unknown",
    removal: { effect: "unknown" },
    upload: { upload: "applied" },
  });
  expect(state.invoke.mock.calls.filter((call) => call[1] === "delete_attachment")).toHaveLength(1);
});

test("an acknowledged rename followed by a failed verification must not claim no change", async () => {
  const state = fixture();
  const original = required(state.invoke.getMockImplementation());
  let saved = false;
  state.invoke.mockImplementation(async (...args) => {
    if (saved && args[1] === "get_document")
      return {
        workspace: "example",
        operation: args[1],
        effect: "not-applied",
        error: "LINEAR_RESOURCE_FAILED",
      };
    const result = await original(...args);
    if (args[1] === "save_document") saved = true;
    return result;
  });
  await expect(
    state.backend.rename("example", documentId, "Renamed", process.cwd()),
  ).rejects.toMatchObject({ effect: "unknown" });
  expect(state.document.title).toBe("Renamed");
});

test("Copy of an existing attachment strips temporary storage signatures without uploading", async () => {
  const state = fixture();
  state.old.url = `${oldAsset}?signature=private`;
  const result = await state.backend.link(
    {
      workspace: "example",
      kind: "issue",
      identifier: "ENG-12",
      source: `${issueUrl}#attachments`,
    },
    `linear://example/attachment/${oldId}?issue=ENG-12#file`,
    process.cwd(),
  );
  expect(result).toMatchObject({ effect: "applied", url: oldAsset });
  expect(JSON.stringify(result)).not.toContain("signature");
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.readBytes).not.toHaveBeenCalled();
});
test("a stale source metadata snapshot refuses upload before any new asset is created", async () => {
  const state = fixture();
  const expected = JSON.stringify({
    id: oldId,
    title: "Old title from prior Read",
    url: oldAsset,
    issue: "ENG-12",
  });
  await expect(
    state.backend.replace(
      "example",
      oldId,
      { file: "/tmp/new.zip" },
      process.cwd(),
      undefined,
      expected,
    ),
  ).rejects.toMatchObject({ code: "LINEAR_STALE_ATTACHMENT", effect: "not-applied" });
  expect(state.upload).not.toHaveBeenCalled();
});
test("a lost upload reply remains uncertain rather than claiming no change", async () => {
  const state = fixture();
  state.upload.mockRejectedValueOnce(new Error("private credentials and transport body"));
  await expect(
    state.backend.replace("example", oldId, { file: "/tmp/new.zip" }, process.cwd()),
  ).rejects.toMatchObject({ code: "LINEAR_ARTIFACT_FAILED", effect: "unknown" });
  expect(state.issue.attachments.some((item) => item.id === oldId)).toBe(true);
  expect(state.invoke.mock.calls.some((call) => call[1] === "delete_attachment")).toBe(false);
});

test("replacement may re-read a not-yet-visible attachment, but never replays upload or deletion", async () => {
  const state = fixture();
  const original = required(state.invoke.getMockImplementation());
  let hidden = false;
  state.invoke.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1] === "get_issue" && state.issue.attachments.length === 2 && !hidden) {
      hidden = true;
      return { ...result, data: { ...state.issue, attachments: [state.issue.attachments[0]] } };
    }
    return result;
  });
  const result = await state.backend.replace(
    "example",
    oldId,
    { file: "/tmp/new.zip" },
    process.cwd(),
  );
  expect(result).toMatchObject({ effect: "applied", removal: { effect: "applied", id: oldId } });
  expect(state.upload).toHaveBeenCalledOnce();
  expect(
    state.invoke.mock.calls.filter(([, operation]) => operation === "delete_attachment"),
  ).toHaveLength(1);
});

test("an explicit zero project resource count permits the first Copy even when MCP omits resources", async () => {
  const state = fixtureWithHandlers();
  state.project.resources = [];
  state.project.resourceCount = 0;
  const original = required(state.invoke.getMockImplementation());
  state.invoke.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1] === "get_project" && state.project.resourceCount === 0) {
      const { resources: _resources, ...card } = state.project;
      return { ...result, data: card };
    }
    return result;
  });
  const result = await state.handlers.fileOperations(
    "copy",
    {
      path: documentUrl,
      target: `linear://example/project/${projectId}#attachments`,
    },
    { cwd: process.cwd() },
  );
  expect(result).toMatchObject({ ok: true, effect: "applied" });
  expect(
    state.invoke.mock.calls.filter(([, operation]) => operation === "save_project"),
  ).toHaveLength(1);
});
