import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LinearGraphqlClient } from "#axi/graphql.ts";
import { fixtureGraphqlRequest, type FixtureGraphqlRequest } from "./fixtures/graphql-request.ts";
import { run } from "#axi/cli.ts";
import type { Runtime } from "#axi/types.ts";

const id = "00000000-0000-4000-8000-000000000106";
const input = { workspace: "example", issueId: id, identifier: "ENG-755" };
function metadata(estimate: unknown) {
  return {
    viewer: { organization: { urlKey: "example" } },
    issue: {
      id,
      identifier: "ENG-755",
      estimate,
      team: { organization: { urlKey: "example" } },
    },
  };
}
function client(data: unknown, status = 200) {
  const requests: FixtureGraphqlRequest[] = [];
  const native = new LinearGraphqlClient({
    tokenProvider: {
      getToken: async () => "fixture",
      clearCache: async () => {},
    },
    fetchImpl: async (_url, init) => {
      requests.push(fixtureGraphqlRequest(init));
      return new Response(JSON.stringify({ data }), { status });
    },
  });
  return { native, requests };
}

void test("native estimate reads retain actual null, zero and numeric values", async () => {
  for (const estimate of [null, 0, 3.5]) {
    const { native, requests } = client(metadata(estimate));
    assert.deepEqual(await native.readIssueEstimate(input), {
      id,
      identifier: "ENG-755",
      estimate,
    });
    assert.deepEqual(requests[0].variables, { id });
    assert.match(requests[0].query, /viewer\s*\{\s*organization/);
    assert.match(requests[0].query, /team\s*\{\s*organization/);
    assert.doesNotMatch(requests[0].query, /mutation/);
  }
});

void test("native estimate reads require both workspace checks and both issue identities", async () => {
  const viewerMismatch = metadata(1);
  viewerMismatch.viewer.organization.urlKey = "other";
  const ownerMismatch = metadata(1);
  ownerMismatch.issue.team.organization.urlKey = "other";
  const uuidMismatch = metadata(1);
  uuidMismatch.issue.id = "00000000-0000-4000-8000-000000000000";
  const identifierMismatch = metadata(1);
  identifierMismatch.issue.identifier = "ENG-756";
  for (const data of [viewerMismatch, ownerMismatch, uuidMismatch, identifierMismatch]) {
    await assert.rejects(
      client(data).native.readIssueEstimate(input),
      /^Error: LINEAR_IDENTITY_MISMATCH$/,
    );
  }
});

void test("missing or malformed native metadata cannot become an empty estimate", async () => {
  const missingEstimate = metadata(1);
  delete (missingEstimate.issue as Record<string, unknown>).estimate;
  const missingOwner = metadata(1);
  delete (missingOwner.issue as Record<string, unknown>).team;
  for (const data of [
    undefined,
    { viewer: metadata(1).viewer, issue: null },
    missingEstimate,
    missingOwner,
    metadata("3"),
    metadata({ value: 3 }),
  ]) {
    await assert.rejects(
      client(data).native.readIssueEstimate(input),
      /^Error: LINEAR_INVALID_RESPONSE$/,
    );
  }
});

void test("native estimate input is verified before authorization or network access", async () => {
  for (const invalid of [
    { ...input, issueId: "not-a-uuid" },
    { ...input, identifier: "" },
    { ...input, workspace: "example/other" },
  ]) {
    const { native, requests } = client(metadata(1));
    await assert.rejects(native.readIssueEstimate(invalid), /^Error: LINEAR_INPUT_INVALID$/);
    assert.equal(requests.length, 0);
  }
});

void test("native estimate auth and read failures expose only safe errors", async () => {
  for (const [status, code] of [
    [401, "LINEAR_GRAPHQL_AUTH_REQUIRED"],
    [403, "LINEAR_PERMISSION_DENIED"],
    [429, "LINEAR_RATE_LIMITED"],
    [500, "LINEAR_GRAPHQL_FAILED"],
  ] as const) {
    const { native } = client("private response", status);
    await assert.rejects(native.readIssueEstimate(input), new RegExp(`^Error: ${code}$`));
  }
  for (const failure of ["auth", "network"]) {
    const native = new LinearGraphqlClient({
      tokenProvider: {
        getToken: async () => {
          if (failure === "auth") throw new Error("private credential details");
          return "fixture";
        },
        clearCache: async () => {},
      },
      fetchImpl: async () => {
        throw new Error("private network details");
      },
    });
    await assert.rejects(
      native.readIssueEstimate(input),
      new RegExp(
        `^Error: ${failure === "auth" ? "LINEAR_GRAPHQL_AUTH_REQUIRED" : "LINEAR_GRAPHQL_FAILED"}$`,
      ),
    );
  }
});

void test("non-finite estimates and GraphQL errors never pass native verification", async () => {
  for (const estimate of [NaN, Infinity, -Infinity]) {
    const native = new LinearGraphqlClient({
      tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
      fetchImpl: async () => {
        const response = new Response();
        response.json = async () => ({ data: metadata(estimate) });
        return response;
      },
    });
    await assert.rejects(native.readIssueEstimate(input), /^Error: LINEAR_INVALID_RESPONSE$/);
  }
  const native = new LinearGraphqlClient({
    tokenProvider: { getToken: async () => "fixture", clearCache: async () => {} },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: metadata(null),
          errors: [{ message: "private API details", extensions: { code: "FORBIDDEN" } }],
        }),
      ),
  });
  await assert.rejects(native.readIssueEstimate(input), /^Error: LINEAR_PERMISSION_DENIED$/);
});

void test("cancelled native estimate reads do not dispatch a request", async () => {
  const { native, requests } = client(metadata(null));
  const controller = new AbortController();
  controller.abort(new Error("private cancellation details"));
  await assert.rejects(
    native.readIssueEstimate({ ...input, signal: controller.signal }),
    /^Error: LINEAR_GRAPHQL_FAILED$/,
  );
  assert.equal(requests.length, 0);
});
async function invoke(
  t: test.TestContext,
  card: unknown,
  native?: LinearGraphqlClient,
  requestedId = "ENG-755",
  fields?: string[],
) {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-estimate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "input.json");
  await writeFile(filename, JSON.stringify({ id: requestedId, ...(fields ? { fields } : {}) }));
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    searchClient: native,
    client: {
      listTools: async () => [
        {
          name: "get_issue",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              fields: { type: "array", items: { type: "string" } },
            },
            required: ["id"],
          },
        },
      ],
      callTool: async (name) => ({
        structuredContent: name === "get_workspace" ? { url: "https://linear.app/example" } : card,
      }),
    },
  };
  return run(
    ["resources", "invoke", "get_issue", "--workspace", "example", "--input-file", filename],
    runtime,
  );
}

void test("projected issue reads do not fetch an unrelated estimate", async (t) => {
  for (const fields of [["status"], ["delegate"], []]) {
    const { native, requests } = client(metadata(1));
    const output = await invoke(
      t,
      { id: "ENG-755", uuid: id, status: "Todo" },
      native,
      "ENG-755",
      fields,
    );
    assert.match(output, /effect: applied/);
    assert.equal(requests.length, 0);
  }
  const { native, requests } = client(metadata(0));
  const output = await invoke(t, { id: "ENG-755", uuid: id }, native, "ENG-755", ["estimate"]);
  assert.match(output, /effect: applied/);
  assert.ok(output.includes('\\\"estimate\\\":0'));
  assert.equal(requests.length, 1);
});
void test("resource get_issue recovers omitted estimates for both MCP identity shapes", async (t) => {
  for (const card of [
    { id: "ENG-755", uuid: id },
    { id, identifier: "ENG-755" },
  ]) {
    for (const estimate of [null, 0, 5]) {
      const { native, requests } = client(metadata(estimate));
      const output = await invoke(t, card, native);
      assert.match(output, /effect: applied/);
      assert.ok(output.includes(`\\"estimate\\":${estimate}`), output);
      assert.equal(requests.length, 1);
    }
  }
});

void test("explicit MCP estimates and runtimes without native support are unchanged", async (t) => {
  for (const estimate of [null, 0, 2]) {
    const { native, requests } = client("should not be read");
    const output = await invoke(t, { id: "ENG-755", uuid: id, estimate }, native);
    assert.match(output, /effect: applied/);
    assert.ok(output.includes(`\\"estimate\\":${estimate}`), output);
    assert.equal(requests.length, 0);
  }
  const output = await invoke(t, { id: "ENG-755", uuid: id });
  assert.match(output, /effect: applied/);
  assert.doesNotMatch(output, /estimate/);
});

void test("resource read refuses failed native enrichment instead of confirming guessed data", async (t) => {
  const data = metadata(1);
  data.issue.team.organization.urlKey = "other";
  for (const [native, error] of [
    [client(data).native, "LINEAR_IDENTITY_MISMATCH"],
    [client(metadata(1), 403).native, "LINEAR_PERMISSION_DENIED"],
    [client({ issue: null }).native, "LINEAR_INVALID_RESPONSE"],
  ] as const) {
    const output = await invoke(t, { id: "ENG-755", uuid: id }, native);
    assert.match(output, /effect: not-applied/);
    assert.match(
      output,
      new RegExp(`error: LINEAR_ISSUE_ENRICHMENT_${error.slice("LINEAR_".length)}`),
    );
    assert.match(output, /data: "null"/);
  }
});

void test("resource enrichment does not trust incomplete or conflicting MCP identities", async (t) => {
  for (const card of [
    { id: "ENG-755" },
    { id, identifier: "ENG-756" },
    { id: "ENG-755", uuid: id, identifier: "ENG-756" },
    null,
  ]) {
    const { native, requests } = client(metadata(1));
    const output = await invoke(t, card, native);
    assert.match(output, /effect: not-applied/);
    assert.equal(requests.length, 0);
  }
});
