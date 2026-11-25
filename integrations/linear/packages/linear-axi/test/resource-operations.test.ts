/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatError, run } from "#axi/cli.ts";
import type { Runtime } from "#axi/types.ts";
import { unexpectedSearch } from "./fixtures/native-search.ts";
import { LINEAR_OPERATIONS } from "#axi/lib/operation-catalog.ts";
import { WORKFLOW_OPERATIONS } from "#axi/native-workflow.ts";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const mcpOperations = LINEAR_OPERATIONS.filter(
  (name) => !new Set<string>(WORKFLOW_OPERATIONS).has(name),
);

interface SchemaTool {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const targetSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

function setup(tools: SchemaTool[], workspace = "example") {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    client: {
      listTools: async () => [
        { name: "get_workspace", inputSchema: emptySchema },
        ...tools.filter((tool) => tool.name !== "get_workspace"),
      ],
      callTool: async (name, input) => {
        calls.push([name, input]);
        return {
          structuredContent:
            name === "get_workspace"
              ? { url: `https://linear.app/${workspace}` }
              : { id: "saved", input },
        };
      },
    },
  };
  return { runtime, calls };
}
async function inputFile(t: test.TestContext, input: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-resource-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "input.json");
  await writeFile(file, JSON.stringify(input), { mode: 0o600 });
  return file;
}
function invocation(operation: string, file: string, workspace = "example") {
  return ["resources", "invoke", operation, "--workspace", workspace, "--input-file", file];
}

void test("preflight CLI failures explain the stage and cause instead of suggesting an unrelated login", async () => {
  const { runtime } = setup([]);
  runtime.client.listTools = async () => {
    throw new StreamableHTTPError(429, "private response body");
  };
  let caught: unknown;
  try {
    await run(["resources", "capabilities", "--workspace", "example"], runtime);
  } catch (error) {
    caught = error;
  }
  const output = formatError(caught).output;
  assert.match(output, /fetching the available operations/);
  assert.match(output, /rate-limited/);
  assert.doesNotMatch(output, /auth login|private response body/);
});

void test("failed read receipts carry a plain-English diagnosis beside their safe error code", async (t) => {
  const { runtime } = setup([{ name: "get_issue", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    throw new StreamableHTTPError(429, "private response body");
  };
  const output = await run(invocation("get_issue", await inputFile(t, { id: "ENG-1" })), runtime);
  assert.match(output, /LINEAR_OPERATION_RATE_LIMITED/);
  assert.match(output, /diagnosis: .*requesting the resource/);
  assert.match(output, /rate-limited/);
  assert.doesNotMatch(output, /private response body/);
});
void test("each approved operation uses its advertised schema and no operation outside the catalog is callable", async (t) => {
  const tools = mcpOperations.map((name) => ({
    name,
    inputSchema: name === "get_workspace" ? emptySchema : targetSchema,
  }));
  const { runtime, calls } = setup(tools);
  const file = await inputFile(t, { id: "target" });
  const empty = await inputFile(t, {});
  assert.equal(LINEAR_OPERATIONS.length, 80);
  assert.equal(new Set(LINEAR_OPERATIONS).size, 80);
  for (const operation of [
    "delete_document",
    "delete_workflow_skill",
    "delete_workflow_template",
  ] as const) {
    assert.ok(WORKFLOW_OPERATIONS.includes(operation));
    assert.equal(mcpOperations.includes(operation), false);
  }
  assert.ok(WORKFLOW_OPERATIONS.includes("create_workflow_template"));
  assert.equal(mcpOperations.includes("create_workflow_template"), false);
  for (const operation of mcpOperations) {
    const output = await run(
      invocation(operation, operation === "get_workspace" ? empty : file),
      runtime,
    );
    assert.match(output, /effect: applied/);
    assert.match(output, new RegExp(`operation: ${operation}\\n`));
    assert.equal(calls.at(-1)?.[0], operation);
  }
  const capabilities = await run(["resources", "capabilities", "--workspace", "example"], runtime);
  assert.match(capabilities, /items\[71\]/);
});
void test("capability discovery preserves recognized authorization failures before any request", async () => {
  const { runtime, calls } = setup([]);
  let attempts = 0;
  runtime.client.listTools = async () => {
    attempts++;
    throw new UnauthorizedError("private token and authorization URL");
  };
  await assert.rejects(
    run(["resources", "capabilities", "--workspace", "example"], runtime),
    /^Error: LINEAR_CAPABILITIES_AUTH_REQUIRED$/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

void test("workspace failures identify their stage without invoking the requested read", async (t) => {
  for (const [status, reason] of [
    [401, "AUTH_REQUIRED"],
    [403, "PERMISSION_DENIED"],
    [429, "RATE_LIMITED"],
  ] as const) {
    const { runtime, calls } = setup([{ name: "get_issue", inputSchema: targetSchema }]);
    runtime.client.callTool = async (name, input) => {
      calls.push([name, input]);
      throw new StreamableHTTPError(status, "private response and bearer-value");
    };
    await assert.rejects(
      run(invocation("get_issue", await inputFile(t, { id: "ENG-1" })), runtime),
      new RegExp(`^Error: LINEAR_WORKSPACE_${reason}$`),
    );
    assert.deepEqual(calls, [["get_workspace", {}]]);
  }
});

void test("read failures use structured causes without exposing private messages or replaying", async (t) => {
  const cases: Array<[unknown, string]> = [
    [new StreamableHTTPError(403, "private forbidden response"), "PERMISSION_DENIED"],
    [new StreamableHTTPError(429, "private rate response"), "RATE_LIMITED"],
    [
      new Error("private fetch failure", {
        cause: Object.assign(new Error("private host"), { code: "ECONNRESET" }),
      }),
      "CONNECTION_FAILED",
    ],
    [new DOMException("private deadline", "TimeoutError"), "TIMEOUT"],
    [new DOMException("private cancellation", "AbortError"), "CANCELLED"],
    [new Error("private unauthorized 401, forbidden 403 and timeout"), "UNKNOWN"],
    [
      Object.assign(new Error("private HTTP-shaped failure"), { status: 403, code: 403 }),
      "UNKNOWN",
    ],
    [{ status: 401, message: "private HTTP-shaped object" }, "UNKNOWN"],
  ];
  for (const [failure, reason] of cases) {
    const { runtime, calls } = setup([{ name: "get_issue", inputSchema: targetSchema }]);
    const original = runtime.client.callTool;
    runtime.client.callTool = async (name, input) => {
      if (name === "get_workspace") return original(name, input);
      calls.push([name, input]);
      throw failure;
    };
    const output = await run(invocation("get_issue", await inputFile(t, { id: "ENG-1" })), runtime);
    assert.match(output, new RegExp(`error: LINEAR_OPERATION_${reason}`));
    assert.match(output, /effect: not-applied/);
    assert.match(output, /data: "null"/);
    assert.doesNotMatch(output, /private|bearer-value/);
    assert.equal(calls.filter(([name]) => name === "get_issue").length, 1);
  }
});

/**
 * The shape Node 24 fetch produced against mcp.linear.app on a loaded machine: happy-eyeballs
 * (autoSelectFamily) gave up after every address attempt failed before the socket opened.
 */
function connectFailure(): Error {
  const attempt = (code: string, address: string) =>
    Object.assign(new Error(`connect ${code} ${address}:443`), {
      code,
      syscall: "connect",
      address,
      port: 443,
    });
  const error = Object.assign(
    new AggregateError([
      attempt("ETIMEDOUT", "192.0.2.21"),
      attempt("ENETUNREACH", "2001:db8::21"),
      attempt("ETIMEDOUT", "198.51.100.45"),
    ]),
    { code: "ETIMEDOUT" },
  );
  return new TypeError("fetch failed", { cause: error });
}

void test("a mutation whose connection never opened is not applied", async (t) => {
  const failure = connectFailure();
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    calls.push([name, input]);
    throw failure;
  };
  const output = await run(invocation("save_issue", await inputFile(t, { id: "ENG-1" })), runtime);
  assert.match(output, /error: LINEAR_OPERATION_CONNECT_FAILED/);
  assert.match(output, /effect: not-applied/);
  assert.match(output, /diagnosis: .*Could not open a connection to Linear/);
  assert.equal(calls.filter(([name]) => name === "save_issue").length, 1);
});

void test("a mutation whose established connection failed keeps an unknown effect", async (t) => {
  const cases: Array<[Error, string]> = [
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("private reset"), { code: "ECONNRESET", syscall: "read" }),
      }),
      "CONNECTION_FAILED",
    ],
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("private socket timeout"), {
          code: "ETIMEDOUT",
          syscall: "read",
        }),
      }),
      "TIMEOUT",
    ],
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("private headers timeout"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      }),
      "TIMEOUT",
    ],
  ];
  for (const [failure, reason] of cases) {
    const { runtime } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
    const original = runtime.client.callTool;
    runtime.client.callTool = async (name, input) => {
      if (name === "get_workspace") return original(name, input);
      throw failure;
    };
    const output = await run(
      invocation("save_issue", await inputFile(t, { id: "ENG-1" })),
      runtime,
    );
    assert.match(output, new RegExp(`error: LINEAR_OPERATION_${reason}\\n`));
    assert.match(output, /effect: unknown/);
    assert.match(output, /Do not retry automatically/);
    assert.doesNotMatch(output, /private/);
  }
});

void test("a comment whose save connection never opened is not applied", async () => {
  for (const [failure, effect] of [
    [connectFailure(), "not-applied"],
    [
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("private reset"), { code: "ECONNRESET", syscall: "read" }),
      }),
      "unknown",
    ],
  ] as const) {
    const { runtime, calls } = setup([]);
    runtime.client.callTool = async (name, input) => {
      calls.push([name, input]);
      if (name === "save_comment") throw failure;
      return { structuredContent: { id: "ENG-12", identifier: "ENG-12", title: "Fixture" } };
    };
    let caught: unknown;
    try {
      await run(["comments", "create", "--issue", "ENG-12", "--body", "Ready"], runtime);
    } catch (error) {
      caught = error;
    }
    const output = formatError(caught).output;
    assert.match(output, /^error: LINEAR_OPERATION_(?:CONNECT|CONNECTION)_FAILED$/mu);
    assert.match(output, new RegExp(`^effect: ${effect}$`, "mu"));
    assert.equal(calls.filter(([name]) => name === "save_comment").length, 1);
  }
});

void test("legacy commands report a transport cause as a closed code instead of raw fetch text", async () => {
  const connect = formatError(connectFailure()).output;
  assert.match(connect, /^error: LINEAR_OPERATION_CONNECT_FAILED$/mu);
  assert.match(connect, /Could not open a connection to Linear/);
  assert.doesNotMatch(connect, /fetch failed|auth login|^effect:/mu);
  const other = formatError(new Error("private unrecognized failure")).output;
  assert.match(other, /^error: private unrecognized failure$/mu);
});

void test("an isError result reports backend rejection without interpreting its private body", async (t) => {
  const { runtime, calls } = setup([{ name: "get_issue", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    calls.push([name, input]);
    return {
      isError: true,
      content: [{ type: "text", text: "private unauthorized 401 and permission denied" }],
    };
  };
  const output = await run(invocation("get_issue", await inputFile(t, { id: "ENG-1" })), runtime);
  assert.match(output, /error: LINEAR_OPERATION_BACKEND_REJECTED/);
  assert.match(output, /effect: not-applied/);
  assert.doesNotMatch(output, /private|AUTH_REQUIRED|PERMISSION_DENIED/);
  assert.equal(calls.filter(([name]) => name === "get_issue").length, 1);
});

void test("recognized missing issue errors are classified without leaking backend details or retrying", async (t) => {
  for (const operation of ["get_issue", "save_issue"]) {
    const { runtime, calls } = setup([{ name: operation, inputSchema: targetSchema }]);
    const original = runtime.client.callTool;
    runtime.client.callTool = async (name, input) => {
      if (name === "get_workspace") return original(name, input);
      calls.push([name, input]);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "invalid_request",
              message: "Could not find referenced Issue.",
              status: 400,
              requestId: "private-request-id",
            }),
          },
        ],
      };
    };
    const output = await run(invocation(operation, await inputFile(t, { id: "ENG-1" })), runtime);
    assert.match(output, /error: LINEAR_OPERATION_ISSUE_NOT_FOUND/);
    assert.match(
      output,
      new RegExp(`effect: ${operation === "get_issue" ? "not-applied" : "unknown"}`),
    );
    assert.doesNotMatch(output, /private-request-id/);
    assert.equal(calls.filter(([name]) => name === operation).length, 1);
  }
});

void test("known protocol causes remain private and ambiguous text cannot claim a missing issue", async (t) => {
  const bodies = [
    [
      {
        type: "text",
        text: JSON.stringify({
          error: "invalid_request",
          status: 400,
          message: "Could not find referenced Issue. private-secret",
        }),
      },
    ],
    [
      {
        type: "text",
        text: JSON.stringify({
          error: "invalid_request",
          status: 403,
          message: "Could not find referenced Issue.",
        }),
      },
    ],
    [
      {
        type: "text",
        text: JSON.stringify({
          error: "invalid_request",
          status: 400,
          message: "Could not find referenced Issue.",
        }),
      },
      { type: "text", text: "private-secret" },
    ],
    [{ type: "text", text: "private-secret" }],
  ];
  const reasons = [
    "VALIDATION_FAILED",
    "PERMISSION_DENIED",
    "BACKEND_REJECTED",
    "BACKEND_REJECTED",
  ];
  for (const [index, content] of bodies.entries()) {
    const { runtime } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
    const original = runtime.client.callTool;
    runtime.client.callTool = async (name, input) =>
      name === "get_workspace" ? original(name, input) : { isError: true, content };
    const output = await run(
      invocation("save_issue", await inputFile(t, { id: "ENG-1" })),
      runtime,
    );
    const { decode } = await import("@toon-format/toon-v4");
    assert.equal(
      (decode(output) as { invocation: { error: string } }).invocation.error,
      `LINEAR_OPERATION_${reasons[index]}`,
    );
    assert.match(output, /effect: unknown/);
    assert.doesNotMatch(output, /private-secret|ISSUE_NOT_FOUND/);
  }
});

void test("structured MCP rejection causes survive issue creation without private diagnostics or replay", async (t) => {
  const { decode } = await import("@toon-format/toon-v4");
  const cases: Array<[unknown, string]> = [
    [
      { error: "invalid_request", status: 400, message: "private invalid delegate bearer-value" },
      "VALIDATION_FAILED",
    ],
    [
      { error: "invalid_token", message: "private expired credential bearer-value" },
      "AUTH_REQUIRED",
    ],
    [{ error: { code: "FORBIDDEN", message: "private permission details" } }, "PERMISSION_DENIED"],
    [
      { errors: [{ message: "private quota details", extensions: { code: "RATELIMITED" } }] },
      "RATE_LIMITED",
    ],
    [{ status: 403, message: "private permission details" }, "PERMISSION_DENIED"],
    [
      { error: "unrecognized", message: "private unauthorized 401 permission denied" },
      "BACKEND_REJECTED",
    ],
    [{ message: "private forbidden 403" }, "BACKEND_REJECTED"],
  ];
  const input = {
    team: "ENG",
    title: "Fixture: improve build feedback",
    delegate: "fixture-assistant",
  };
  for (const [failure, reason] of cases) {
    for (const structured of [false, true]) {
      const schema = {
        type: "object",
        properties: {
          team: { type: "string" },
          title: { type: "string" },
          delegate: { type: "string" },
        },
        additionalProperties: false,
      };
      const { runtime, calls } = setup([{ name: "save_issue", inputSchema: schema }]);
      const original = runtime.client.callTool;
      runtime.client.callTool = async (name, args) => {
        if (name === "get_workspace") return original(name, args);
        calls.push([name, args]);
        return {
          isError: true,
          ...(structured
            ? { structuredContent: failure }
            : { content: [{ type: "text", text: JSON.stringify(failure) }] }),
        };
      };
      const output = await run(invocation("save_issue", await inputFile(t, input)), runtime);
      const receipt = (decode(output) as { invocation: Record<string, unknown> }).invocation;
      assert.equal(receipt.error, `LINEAR_OPERATION_${reason}`);
      assert.equal(receipt.effect, "unknown");
      assert.equal(receipt.data, "null");
      assert.deepEqual(
        calls.filter(([name]) => name === "save_issue"),
        [["save_issue", input]],
      );
      assert.doesNotMatch(output, /private|bearer-value/);
    }
  }
});

void test("MCP rate rejection preserves only public timing while mutation delivery remains unknown", async (t) => {
  const { decode } = await import("@toon-format/toon-v4");
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, args) => {
    if (name === "get_workspace") return original(name, args);
    calls.push([name, args]);
    return {
      isError: true,
      structuredContent: {
        error: "RATE_LIMITED",
        message: "private backend response",
        rateLimit: {
          retryAfterMs: 1500,
          requestsRemaining: 0,
          token: "bearer-value",
          endpoint: "private/endpoint",
        },
      },
    };
  };
  const output = await run(invocation("save_issue", await inputFile(t, { id: "ENG-1" })), runtime);
  const receipt = (decode(output) as { invocation: Record<string, unknown> }).invocation;
  assert.equal(receipt.error, "LINEAR_OPERATION_RATE_LIMITED");
  assert.equal(receipt.effect, "unknown");
  assert.deepEqual(JSON.parse(receipt.rateLimit as string), {
    retryAfterMs: 1500,
    requestsRemaining: 0,
  });
  assert.doesNotMatch(output, /private|bearer-value/);
  assert.equal(calls.filter(([name]) => name === "save_issue").length, 1);
});

void test("workspace MCP rejections retain recognized causes before issue creation", async (t) => {
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
  runtime.client.callTool = async (name, args) => {
    calls.push([name, args]);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "invalid_token", message: "private bearer-value" }),
        },
      ],
    };
  };
  await assert.rejects(
    run(invocation("save_issue", await inputFile(t, { id: "ENG-1" })), runtime),
    { message: "LINEAR_WORKSPACE_AUTH_REQUIRED" },
  );
  assert.deepEqual(calls, [["get_workspace", {}]]);
});
void test("issue enrichment failures remain distinct from successful MCP reads", async (t) => {
  const { runtime, calls } = setup([{ name: "get_issue", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    calls.push([name, input]);
    return { structuredContent: { id: "ENG-1", uuid: "00000000-0000-4000-8000-000000000001" } };
  };
  let enrichments = 0;
  runtime.searchClient = {
    searchObjects: unexpectedSearch,
    readIssueEstimate: async () => {
      enrichments++;
      throw new Error("LINEAR_PERMISSION_DENIED");
    },
  };
  const output = await run(invocation("get_issue", await inputFile(t, { id: "ENG-1" })), runtime);
  assert.match(output, /error: LINEAR_ISSUE_ENRICHMENT_PERMISSION_DENIED/);
  assert.match(output, /effect: not-applied/);
  assert.match(output, /data: "null"/);
  assert.equal(enrichments, 1);
  assert.equal(calls.filter(([name]) => name === "get_issue").length, 1);
});

void test("lost mutation responses keep unknown effects even for recognized safe causes", async (t) => {
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    calls.push([name, input]);
    throw new StreamableHTTPError(429, "private rate response");
  };
  const output = await run(invocation("save_issue", await inputFile(t, { id: "ENG-1" })), runtime);
  assert.match(output, /error: LINEAR_OPERATION_RATE_LIMITED/);
  assert.match(output, /effect: unknown/);
  assert.doesNotMatch(output, /private/);
  assert.equal(calls.filter(([name]) => name === "save_issue").length, 1);
});

void test("native workflow failures retain effect and correlation identity without leaking error data", async (t) => {
  const targetId = "00000000-0000-4000-8000-000000000001";
  for (const [operation, effect, error, expectedEffect, reason] of [
    [
      "get_workflow_skill",
      "applied",
      "LINEAR_PERMISSION_DENIED",
      "not-applied",
      "PERMISSION_DENIED",
    ],
    [
      "save_workflow_skill",
      "not-applied",
      "LINEAR_GRAPHQL_AUTH_REQUIRED",
      "not-applied",
      "AUTH_REQUIRED",
    ],
    ["save_workflow_skill", "unknown", "private native failure", "unknown", "UNKNOWN"],
    ["save_workflow_skill", "applied", "LINEAR_INVALID_RESPONSE", "applied", "INVALID_RESPONSE"],
  ] as const) {
    const { runtime, calls } = setup([]);
    let attempts = 0;
    runtime.searchClient = {
      searchObjects: unexpectedSearch,
      workflowCapabilities: () => [{ name: operation, inputSchema: targetSchema }],
      invokeWorkflow: async () => {
        attempts++;
        return { effect, data: { private: "native response body" }, error, targetId };
      },
    };
    const output = await run(invocation(operation, await inputFile(t, { id: targetId })), runtime);
    assert.match(output, new RegExp(`error: LINEAR_OPERATION_${reason}`));
    assert.match(output, new RegExp(`effect: ${expectedEffect}`));
    assert.match(output, /data: "null"/);
    assert.match(output, new RegExp(`targetId: ${targetId}`));
    assert.doesNotMatch(output, /private|native response body/);
    assert.equal(attempts, 1);
    assert.deepEqual(calls, [["get_workspace", {}]]);
  }
});

void test("malformed native acknowledgements keep known correlation identity and are never replayed", async (t) => {
  const targetId = "00000000-0000-4000-8000-000000000001";
  const { runtime } = setup([]);
  let attempts = 0;
  runtime.searchClient = {
    searchObjects: unexpectedSearch,
    workflowCapabilities: () => [{ name: "save_workflow_skill", inputSchema: targetSchema }],
    invokeWorkflow: async () => {
      attempts++;
      return { effect: "applied", data: undefined, targetId };
    },
  };
  const output = await run(
    invocation("save_workflow_skill", await inputFile(t, { id: targetId })),
    runtime,
  );
  assert.match(output, /error: LINEAR_OPERATION_INVALID_RESPONSE/);
  assert.match(output, /effect: unknown/);
  assert.match(output, new RegExp(`targetId: ${targetId}`));
  assert.equal(attempts, 1);
});
const customerTools: SchemaTool[] = [
  {
    name: "list_customers",
    inputSchema: {
      ...emptySchema,
      properties: {
        query: { type: "string" },
        limit: { type: "number", maximum: 250 },
        includeNeeds: { type: "boolean", default: false },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "list_customer_needs",
    inputSchema: {
      ...emptySchema,
      properties: {
        project: { type: "string" },
        issue: { type: "string" },
        limit: { type: "number", maximum: 250 },
        cursor: { type: "string" },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "save_customer_need",
    inputSchema: {
      ...emptySchema,
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        customer: { type: "string" },
        project: { type: "string" },
        issue: { type: "string" },
        priority: { type: "number" },
        source: { type: "string", format: "uri" },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

void test("customer directories and request writes expose their schemas without exposing customer administration", async (t) => {
  const { runtime, calls } = setup([
    ...customerTools,
    { name: "save_customer", inputSchema: targetSchema },
    { name: "delete_customer", inputSchema: targetSchema },
    { name: "delete_customer_need", inputSchema: targetSchema },
  ]);
  const output = await run(["resources", "capabilities", "--workspace", "example"], runtime);
  for (const { name } of customerTools) assert.match(output, new RegExp(name));
  assert.doesNotMatch(output, /save_customer,|delete_customer/);
  calls.length = 0;
  const file = await inputFile(t, { id: "customer" });
  for (const name of ["save_customer", "delete_customer", "delete_customer_need"])
    await assert.rejects(run(invocation(name, file), runtime), /LINEAR_RESOURCE_UNSUPPORTED/);
  assert.deepEqual(calls, []);
});

void test("customer requests keep their project scope and identity across list, create and link operations", async (t) => {
  const { runtime, calls } = setup(customerTools);
  const inputs: Array<[string, Record<string, unknown>]> = [
    ["list_customers", { query: "Aleksandr", limit: 10 }],
    ["list_customer_needs", { project: "project", limit: 10, cursor: "next-page" }],
    [
      "save_customer_need",
      { body: "First line\nSecond line", customer: "customer", project: "project", priority: 0 },
    ],
    ["save_customer_need", { id: "request", issue: "ENG-1" }],
  ];
  for (const [operation, input] of inputs) {
    const output = await run(invocation(operation, await inputFile(t, input)), runtime);
    assert.match(output, /effect: applied/);
    assert.match(output, new RegExp(`operation: ${operation}\\n`));
    assert.deepEqual(calls.splice(0), [
      ["get_workspace", {}],
      [operation, input],
    ]);
  }
});

void test("customer request writes refuse wrong workspaces and invalid input before dispatch", async (t) => {
  const { runtime, calls } = setup(customerTools);
  const valid = { body: "An idea", customer: "customer", project: "project" };
  await assert.rejects(
    run(invocation("save_customer_need", await inputFile(t, valid), "other"), runtime),
    /LINEAR_WORKSPACE_IDENTITY_MISMATCH/,
  );
  for (const input of [
    { ...valid, source: "not a URI" },
    { ...valid, priority: "important" },
    { ...valid, invented: true },
    { id: " ", issue: "ENG-1" },
  ])
    await assert.rejects(
      run(invocation("save_customer_need", await inputFile(t, input)), runtime),
      /LINEAR_INPUT_INVALID/,
    );
  assert.ok(calls.every(([name]) => name === "get_workspace"));
});

void test("customer read failures are not applied and lost request writes remain unknown without replay", async (t) => {
  const { runtime, calls } = setup(customerTools);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    calls.push([name, input]);
    throw new Error("private bearer-value and customer data");
  };
  for (const { name } of customerTools) {
    const input =
      name === "list_customers"
        ? {}
        : name === "list_customer_needs"
          ? { project: "project" }
          : { body: "An idea", customer: "customer", project: "project" };
    const output = await run(invocation(name, await inputFile(t, input)), runtime);
    assert.match(output, name === "save_customer_need" ? /effect: unknown/ : /effect: not-applied/);
    assert.match(output, /error: LINEAR_OPERATION_UNKNOWN/);
    assert.doesNotMatch(output, /bearer-value|customer data/);
    assert.equal(calls.filter(([operation]) => operation === name).length, 1);
  }
});
void test("nested named objects reject unknown fields even when the published schema omits additionalProperties", async (t) => {
  const schema = {
    ...targetSchema,
    properties: {
      id: { type: "string" },
      settings: { type: "object", properties: { enabled: { type: "boolean" } } },
      metadata: { type: "object", additionalProperties: { type: "string" } },
    },
  };
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: schema }]);
  await assert.rejects(
    run(
      invocation("save_issue", await inputFile(t, { id: "ENG-1", settings: { invented: true } })),
      runtime,
    ),
    /LINEAR_INPUT_INVALID/,
  );
  assert.deepEqual(calls, [["get_workspace", {}]]);
  const valid = { id: "ENG-1", settings: { enabled: true }, metadata: { source: "provider" } };
  assert.match(
    await run(invocation("save_issue", await inputFile(t, valid)), runtime),
    /effect: applied/,
  );
  assert.deepEqual(calls.at(-1), ["save_issue", valid]);
});
void test("capabilities expose available approved schemas and annotations, never arbitrary tool names", async () => {
  const { runtime, calls } = setup([
    { name: "save_issue", inputSchema: targetSchema, annotations: { destructiveHint: false } },
    { name: "merge_diff", inputSchema: targetSchema },
    { name: "unapproved_method", inputSchema: emptySchema },
  ]);
  const output = await run(["resources", "capabilities", "--workspace", "example"], runtime);
  assert.match(output, /capabilities:/);
  assert.match(output, /save_issue/);
  assert.match(output, /merge_diff/);
  assert.match(output, /inputSchema/);
  assert.match(output, /destructiveHint/);
  assert.doesNotMatch(output, /unapproved_method/);
  assert.deepEqual(calls, [["get_workspace", {}]]);
});

void test("invoke validates a 2020 schema and preserves full response data in its receipt", async (t) => {
  const schema = {
    ...targetSchema,
    properties: {
      id: { type: "string" },
      state: { enum: ["Todo", "Done"] },
      addLabels: { type: "array", items: { type: "string" }, maxItems: 2 },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: { url: { type: "string", format: "uri" }, title: { type: "string" } },
          required: ["url", "title"],
          additionalProperties: false,
        },
      },
    },
  };
  const input = {
    id: "ENG-1",
    state: "Done",
    addLabels: ["Bug"],
    links: [{ url: "https://example.org/report", title: "Report" }],
  };
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: schema }]);
  const output = await run(invocation("save_issue", await inputFile(t, input)), runtime);
  assert.match(output, /invocation:/);
  assert.match(output, /workspace: example/);
  assert.match(output, /operation: save_issue/);
  assert.match(output, /effect: applied/);
  assert.match(output, /data:/);
  assert.match(output, /saved/);
  assert.deepEqual(calls, [
    ["get_workspace", {}],
    ["save_issue", input],
  ]);
});

void test("invalid enums, types, nested fields, formats and empty identities refuse before mutation", async (t) => {
  const schema = {
    ...targetSchema,
    properties: {
      id: { type: "string" },
      state: { enum: ["Todo", "Done"] },
      estimate: { type: "number" },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: { url: { type: "string", format: "uri" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
  };
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: schema }]);
  for (const input of [
    { id: "ENG-1", state: "invented" },
    { id: "ENG-1", estimate: "3" },
    { id: "ENG-1", unknown: true },
    { id: "ENG-1", links: [{ url: "not a URI" }] },
    { id: "ENG-1", links: [{ url: "https://example.org", extra: true }] },
    { id: "   " },
    { state: "Done" },
    [],
  ]) {
    const file = await inputFile(t, input);
    await assert.rejects(
      () => run(invocation("save_issue", file), runtime),
      /LINEAR_INPUT_INVALID/,
    );
  }
  assert.ok(calls.every(([name]) => name === "get_workspace"));
});

void test("wrong workspace, missing methods and unapproved operations never dispatch the target", async (t) => {
  const file = await inputFile(t, { id: "ENG-1" });
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
  await assert.rejects(
    () => run(invocation("save_issue", file, "other"), runtime),
    /LINEAR_WORKSPACE_IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    () => run(invocation("merge_diff", file), runtime),
    /LINEAR_RESOURCE_UNSUPPORTED/,
  );
  await assert.rejects(
    () => run(invocation("run_arbitrary_code", file), runtime),
    /LINEAR_RESOURCE_UNSUPPORTED/,
  );
  assert.ok(calls.every(([name]) => name === "get_workspace"));
});

void test("draft-07 null fields and empty body text remain unchanged, with no schema coercion or defaults", async (t) => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string" },
      assignee: { type: ["string", "null"] },
      description: { type: "string" },
      state: { type: "string", default: "Todo" },
    },
    required: ["id"],
    additionalProperties: false,
  };
  const input = { id: "ENG-1", assignee: null, description: "" };
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: schema }]);
  await run(invocation("save_issue", await inputFile(t, input)), runtime);
  assert.deepEqual(calls.at(-1), ["save_issue", input]);
});

void test("mutating lost acknowledgement is unknown and never replayed or leaked", async (t) => {
  const { runtime, calls } = setup([{ name: "merge_diff", inputSchema: targetSchema }]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, args) => {
    if (name === "get_workspace") return original(name, args);
    calls.push([name, args]);
    throw new Error("private bearer-value and raw backend failure");
  };
  const output = await run(invocation("merge_diff", await inputFile(t, { id: "diff" })), runtime);
  assert.match(output, /effect: unknown/);
  assert.match(output, /error: LINEAR_OPERATION_UNKNOWN/);
  assert.doesNotMatch(output, /bearer-value|raw backend/);
  assert.equal(calls.filter(([name]) => name === "merge_diff").length, 1);
});

void test("read failure and explicit backend refusal are safe receipts without private error bodies", async (t) => {
  const { runtime, calls } = setup([
    { name: "get_diff", inputSchema: targetSchema },
    { name: "save_issue", inputSchema: targetSchema },
  ]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, args) => {
    if (name === "get_workspace") return original(name, args);
    calls.push([name, args]);
    if (name === "get_diff") throw new Error("private read failure");
    return { isError: true, content: [{ type: "text", text: "private forbidden response" }] };
  };
  const file = await inputFile(t, { id: "one" });
  for (const name of ["get_diff", "save_issue"]) {
    const output = await run(invocation(name, file), runtime);
    assert.match(output, name === "get_diff" ? /effect: not-applied/ : /effect: unknown/);
    assert.match(
      output,
      name === "get_diff"
        ? /error: LINEAR_OPERATION_UNKNOWN/
        : /error: LINEAR_OPERATION_BACKEND_REJECTED/,
    );
    assert.doesNotMatch(output, /private/);
  }
});

void test("malformed schemas and too-large input files fail before transport calls", async (t) => {
  const { runtime, calls } = setup([
    { name: "save_issue", inputSchema: { type: "not-json-schema" } },
  ]);
  const input = await inputFile(t, { id: "one" });
  await assert.rejects(
    () => run(invocation("save_issue", input), runtime),
    /LINEAR_CAPABILITIES_INVALID_RESPONSE/,
  );
  assert.ok(calls.every(([name]) => name === "get_workspace"));
  calls.length = 0;
  const directory = await mkdtemp(path.join(tmpdir(), "linear-resource-large-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "large.json");
  await writeFile(file, " ".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(
    () => run(invocation("save_issue", file), runtime),
    /LINEAR_INPUT_TOO_LARGE/,
  );
  assert.deepEqual(calls, []);
});

void test("non-files, symlinks and malformed UTF-8 JSON refuse before any backend access", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "linear-resource-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "link.json");
  const invalid = path.join(directory, "invalid.json");
  await writeFile(target, "{}");
  await symlink(target, link);
  await writeFile(invalid, Buffer.from([0xff]));
  const { runtime, calls } = setup([{ name: "save_issue", inputSchema: targetSchema }]);
  let metadataCalls = 0;
  runtime.client.listTools = async () => {
    metadataCalls++;
    return [];
  };
  for (const file of [directory, link, invalid])
    await assert.rejects(
      () => run(invocation("save_issue", file), runtime),
      /LINEAR_INPUT_INVALID/,
    );
  assert.equal(metadataCalls, 0);
  assert.deepEqual(calls, []);
});

void test("server read-only hints cannot turn uncertain merge writes into clean rejections", async (t) => {
  const { runtime, calls } = setup([
    { name: "merge_diff", inputSchema: targetSchema, annotations: { readOnlyHint: true } },
  ]);
  const original = runtime.client.callTool;
  runtime.client.callTool = async (name, input) => {
    if (name === "get_workspace") return original(name, input);
    calls.push([name, input]);
    throw new Error("Lost acknowledgement");
  };
  const output = await run(invocation("merge_diff", await inputFile(t, { id: "one" })), runtime);
  assert.match(output, /effect: unknown/);
  assert.equal(calls.filter(([name]) => name === "merge_diff").length, 1);
});
