import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { GithubApiResources } from "#github/api.ts";
import { GithubApiError } from "#github/client.ts";
import { ResourceError } from "pi-agent-ide/api/resource";

function setup(
  response: {
    status?: number;
    contentType?: string;
    text?: string;
    bytes?: Uint8Array;
    next?: string;
  } = {},
) {
  const request = vi.fn(async (..._args: unknown[]) => ({
    status: response.status ?? 200,
    contentType: response.contentType ?? "application/json",
    bytes: response.bytes ?? Buffer.from(response.text ?? '{"id":17,"name":"resource"}'),
    ...(response.next ? { next: response.next } : {}),
  }));
  const client = {
    request,
    rest: async () => {
      throw new Error("Unexpected repository lookup");
    },
  };
  return { api: new GithubApiResources(async () => client), request };
}

test("navigation excludes URI templates instead of advertising escaped dead links", async () => {
  const template = "https://api.github.com/repos/example/project/issues/1/labels{/name}";
  const { api } = setup({
    text: JSON.stringify({
      labels_url: template,
      issue_url: "https://api.github.com/repos/example/project/issues/1",
    }),
  });
  const result = await api.readText("https://api.github.com/repos/example/project/issues/1", ".");
  assert.ok(result);
  expect(result.content).not.toContain("labels%7B");
  expect(result.content).toContain(template);
  expect(result.content).toContain("- <https://api.github.com/repos/example/project/issues/1>");
});
test("reads an unfamiliar REST resource and leaves linked bodies lazy", async () => {
  const { api, request } = setup({
    text: JSON.stringify({
      id: 17,
      url: "https://api.github.com/orgs/example/packages/npm/widget",
      html_url: "https://github.com/example/project",
    }),
  });
  const result = await api.readText(
    "https://api.github.com/orgs/example/packages/npm/widget",
    "/fixture",
  );
  expect(result?.content).toContain('"id": 17');
  expect(result?.content).toContain("https://api.github.com/orgs/example/packages/npm/widget");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.slice(0, 3)).toEqual([
    "GET",
    "https://api.github.com/orgs/example/packages/npm/widget",
    undefined,
  ]);
});

test("clearing snapshots retires an already dispatched response instead of repopulating the new connection cache", async () => {
  const { api, request } = setup();
  let complete!: (response: { status: number; contentType: string; bytes: Uint8Array }) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = api.perform(
    "github://api/rest",
    JSON.stringify({
      method: "POST",
      path: "/repos/example/project/issues",
      body: { title: "one effect" },
    }),
    "/fixture",
  );
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  api.clear();
  complete({ status: 201, contentType: "application/json", bytes: Buffer.from('{"id":17}') });
  await expect(pending).rejects.toMatchObject({ code: "GH_RESULT_EXPIRED", effect: "unknown" });
  expect(request).toHaveBeenCalledTimes(1);
});
test("clearing during pagination validation cannot restore an old response", async () => {
  let complete!: (response: { data: { id: number; full_name: string } }) => void;
  const lookup = vi.fn(
    () =>
      new Promise<{ data: { id: number; full_name: string } }>((resolve) => {
        complete = resolve;
      }),
  );
  const request = vi.fn(async () => ({
    status: 201,
    contentType: "application/json",
    bytes: Buffer.from('{"id":17}'),
    next: "https://api.github.com/repositories/17/issues?page=2",
  }));
  const client = { request, rest: lookup };
  const api = new GithubApiResources(async () => client);
  const pending = api.perform(
    "github://api/rest",
    JSON.stringify({
      method: "POST",
      path: "/repos/example/project/issues?page=1",
      body: { title: "one effect" },
    }),
    "/fixture",
  );
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
  api.clear();
  complete({ data: { id: 17, full_name: "example/project" } });
  await expect(pending).rejects.toMatchObject({ code: "GH_RESULT_EXPIRED", effect: "unknown" });
  expect(request).toHaveBeenCalledTimes(1);
});
test("Write returns a readable immutable response for arbitrary mutations", async () => {
  const { api, request } = setup({ status: 202, text: '{"accepted":true}' });
  const receipt = await api.perform(
    "github://api/rest",
    JSON.stringify({ method: "DELETE", path: "/repos/example/project/unfamiliar/17" }),
    "/fixture",
  );
  expect(receipt.source).toMatch(/^github:\/\/api\/results\//);
  expect(receipt.status).toBe(202);
  const result = await api.readText(receipt.source, "/fixture");
  expect(result?.content).toContain('"accepted": true');
  expect(request.mock.calls[0]?.slice(0, 3)).toEqual([
    "DELETE",
    "/repos/example/project/unfamiliar/17",
    undefined,
  ]);
  expect(request).toHaveBeenCalledTimes(1);
});

test("GraphQL Write carries variables and operationName and returns its response", async () => {
  const { api, request } = setup({ text: '{"data":{"node":{"id":"NODE"}}}' });
  const payload = {
    query: "query View($id:ID!){node(id:$id){id}}",
    variables: { id: "NODE" },
    operationName: "View",
  };
  const receipt = await api.perform("github://api/graphql", JSON.stringify(payload), "/fixture");
  expect(request.mock.calls[0]?.slice(0, 3)).toEqual(["POST", "/graphql", payload]);
  expect((await api.readText(receipt.source, "/fixture"))?.content).toContain("NODE");
});

test("GraphQL partial errors expose the saved response but do not report mutation success", async () => {
  const { api, request } = setup({
    text: '{"data":{"changed":true},"errors":[{"message":"partial"}]}',
  });
  const error = await api
    .perform("github://api/graphql", '{"query":"mutation { change }"}', "/fixture")
    .catch((error: unknown) => error);
  assert.ok(error instanceof ResourceError);
  expect(error).toMatchObject({ effect: "unknown", code: "GH_GRAPHQL_ERROR" });
  expect(error.source).toMatch(/^github:\/\/api\/results\//);
  expect(request).toHaveBeenCalledTimes(1);
});

test("GraphQL errors through the REST escape hatch also preserve unknown effects", async () => {
  const { api } = setup({ text: '{"data":{"changed":true},"errors":[{"message":"partial"}]}' });
  await expect(
    api.perform(
      "github://api/rest",
      JSON.stringify({ method: "POST", path: "/graphql", body: { query: "mutation {change}" } }),
      "/fixture",
    ),
  ).rejects.toMatchObject({ code: "GH_GRAPHQL_ERROR", effect: "unknown" });
});
test("rejects credential overrides and an untrusted host before any request", async () => {
  const { api, request } = setup();
  for (const input of [
    {
      code: "GH_INVALID_ROUTE",
      value: { method: "GET", path: "https://evil.example/repos/example/project" },
    },
    {
      code: "GH_INVALID_INPUT",
      value: {
        method: "POST",
        path: "/repos/example/project",
        headers: { Authorization: "another identity" },
      },
    },
    {
      code: "GH_CREDENTIAL_OVERRIDE",
      value: { method: "GET", path: "/user?access_token=another-identity" },
    },
  ])
    await expect(
      api.perform("github://api/rest", JSON.stringify(input.value), "/fixture"),
    ).rejects.toMatchObject({ code: input.code });
  expect(request).not.toHaveBeenCalled();
});

test("pagination keeps the original route and filters", async () => {
  const source =
    "https://api.github.com/repos/example/project/actions/runs?branch=feature&per_page=1";
  const next = `${source}&page=2`;
  const allowed = setup({ next });
  expect((await allowed.api.readText(source, "/fixture"))?.content).toContain(next);
  const changed = setup({
    next: "https://api.github.com/repos/example/other/actions/runs?branch=feature&page=2",
  });
  await expect(changed.api.readText(source, "/fixture")).rejects.toThrow("GH_INVALID_PAGINATION");
});

test("retains original binary windows without pretending to extract an archive", async () => {
  const bytes = Buffer.from([80, 75, 3, 4, 255, 0, 7]);
  const { api } = setup({ contentType: "application/zip", bytes });
  const receipt = await api.perform(
    "github://api/rest",
    '{"method":"GET","path":"/repos/example/project/actions/artifacts/17/zip"}',
    "/fixture",
  );
  const resolver = api.resolver();
  const resolved = await resolver.tryResolve(receipt.source, { cwd: "/fixture" });
  expect(resolved.kind).toBe("resolved");
  if (resolved.kind !== "resolved") throw new Error("Expected a resolved byte resource");
  assert.ok(resolved.resource.readBytes);
  const window = await resolved.resource.readBytes(2, 3, {});
  expect([...window.bytes]).toEqual([3, 4, 255]);
  expect(window.totalBytes).toBe(7);
  expect((await api.readText(receipt.source, "/fixture"))?.content).toContain("not extracted");
});

test("Read cannot execute GraphQL operations through a query-string URL", async () => {
  const { api, request } = setup();
  await expect(
    api.readText("https://api.github.com/graphql?query=mutation%20%7Bchange%7D", "/fixture"),
  ).rejects.toThrow("GH_GRAPHQL_WRITE_REQUIRED");
  expect(request).not.toHaveBeenCalled();
});
test("GitHub raw file media remains readable text instead of invalid JSON", async () => {
  const { api } = setup({
    contentType: "application/vnd.github.raw+json; charset=utf-8",
    text: "first line\nsecond line\n",
  });
  const receipt = await api.perform(
    "github://api/rest",
    '{"method":"GET","path":"/repos/example/project/contents/file","accept":"application/vnd.github.raw+json"}',
    "/fixture",
  );
  expect((await api.readText(receipt.source, "/fixture"))?.content).toContain(
    "first line\nsecond line\n",
  );
});
test("expired response resources fail instead of fetching or guessing", async () => {
  const { api, request } = setup();
  await expect(
    api.readText("github://api/results/00000000-0000-4000-8000-000000000000", "/fixture"),
  ).rejects.toThrow("GH_RESULT_EXPIRED");
  expect(request).not.toHaveBeenCalled();
});

test("signed download URLs are redacted in presentation while raw bytes stay exact", async () => {
  const original = JSON.stringify({
    download_url:
      "https://raw.githubusercontent.com/example/project/main/file?token=private-download-token",
  });
  const { api } = setup({ text: original });
  const receipt = await api.perform(
    "github://api/rest",
    '{"method":"GET","path":"/repos/example/project/contents/file"}',
    "/fixture",
  );
  expect((await api.readText(receipt.source, "/fixture"))?.content).not.toContain(
    "private-download-token",
  );
  const result = await api.resolver().tryResolve(receipt.source, { cwd: "/fixture" });
  if (result.kind !== "resolved") throw new Error("Expected an original-byte resource");
  assert.ok(result.resource.readBytes);
  const window = await result.resource.readBytes(0, undefined, {});
  expect(Buffer.from(window.bytes).toString()).toBe(original);
});
test("response eviction and shutdown retire snapshots without replaying requests", async () => {
  const { api, request } = setup();
  const first = await api.perform(
    "github://api/rest",
    '{"method":"GET","path":"/rate_limit"}',
    "/fixture",
  );
  let last = first;
  for (let i = 0; i < 16; i++)
    last = await api.perform(
      "github://api/rest",
      '{"method":"GET","path":"/rate_limit"}',
      "/fixture",
    );
  await expect(api.readText(first.source, "/fixture")).rejects.toThrow("GH_RESULT_EXPIRED");
  expect((await api.readText(last.source, "/fixture"))?.content).toContain("resource");
  api.clear();
  await expect(api.readText(last.source, "/fixture")).rejects.toThrow("GH_RESULT_EXPIRED");
  expect(request).toHaveBeenCalledTimes(17);
});
test("signed URL credentials stay out of links and embedded plaintext, but not original bytes", async () => {
  for (const response of [
    {
      text: JSON.stringify({
        url: "https://api.github.com/download?sig=signature-marker&credential=credential-marker",
      }),
    },
    {
      contentType: "text/plain",
      text: "Download here: https://example.blob.core.windows.net/file?sig=signature-marker&credential=credential-marker then continue.",
    },
  ]) {
    const { api } = setup(response);
    const receipt = await api.perform(
      "github://api/rest",
      '{"method":"GET","path":"/rate_limit"}',
      "/fixture",
    );
    const read = await api.readText(receipt.source, "/fixture");
    assert.ok(read);
    const presented = read.content;
    expect(presented).not.toContain("signature-marker");
    expect(presented).not.toContain("credential-marker");
    const resolved = await api.resolver().tryResolve(receipt.source, { cwd: "/fixture" });
    if (resolved.kind !== "resolved") throw new Error("Expected original bytes");
    assert.ok(resolved.resource.readBytes);
    const window = await resolved.resource.readBytes(0, undefined, {});
    expect(Buffer.from(window.bytes).toString()).toBe(response.text);
  }
});

test("numeric since cursors advance only on supported listing routes", async () => {
  const listing = setup({ next: "https://api.github.com/repositories?since=2" });
  expect(
    (await listing.api.readText("https://api.github.com/repositories?since=1", "/fixture"))
      ?.content,
  ).toContain("since=2");
  const backwards = setup({ next: "https://api.github.com/repositories?since=1" });
  await expect(
    backwards.api.readText("https://api.github.com/repositories?since=2", "/fixture"),
  ).rejects.toThrow("GH_INVALID_PAGINATION");
  const changedDate = setup({
    next: "https://api.github.com/repos/example/project/commits?since=2026-10-02&page=2",
  });
  await expect(
    changedDate.api.readText(
      "https://api.github.com/repos/example/project/commits?since=2026-10-01",
      "/fixture",
    ),
  ).rejects.toThrow("GH_INVALID_PAGINATION");
});

test("a bad mutation pagination link does not discard the completed response", async () => {
  const { api, request } = setup({
    status: 201,
    text: '{"id":23}',
    next: "https://api.github.com/repos/example/other/issues?page=2",
  });
  const failure = await api
    .perform(
      "github://api/rest",
      '{"method":"POST","path":"/repos/example/project/issues","body":{"title":"fixture"}}',
      "/fixture",
    )
    .catch((error: unknown) => error);
  assert.ok(failure instanceof ResourceError);
  expect(failure).toMatchObject({ code: "GH_INVALID_PAGINATION", effect: "unknown" });
  const { source } = failure;
  expect(source).toMatch(/^github:\/\/api\/results\//);
  expect((await api.readText(source, "/fixture"))?.content).toContain('"id": 23');
  expect(request).toHaveBeenCalledTimes(1);
});
test("unknown effects survive the resource boundary and are never replayed", async () => {
  const { api, request } = setup();
  request.mockRejectedValueOnce(new GithubApiError("GH_REQUEST_FAILED", "unknown"));
  await expect(
    api.perform(
      "github://api/rest",
      '{"method":"PATCH","path":"/repos/example/project/unfamiliar/17","body":{"name":"changed"}}',
      "/fixture",
    ),
  ).rejects.toMatchObject({ code: "GH_REQUEST_FAILED", effect: "unknown" });
  expect(request).toHaveBeenCalledTimes(1);
});
