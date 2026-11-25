/// <reference types="node" />
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NamedConnections } from "#axi/named-connections.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(import.meta.resolve("#axi/bin.ts"));
export const COMMENT_ID = "ba09f3e0-4387-4935-b7fa-fbf2ef711af2";
export const COMMENT_ISSUE_ID = "afe17780-2fd9-4b03-bd81-c79199a6c4e5";
export const COMMENT_WORKSPACE = "comment-fixture";
export const COMMENT_PAGE_CURSOR = "comment-next-page";
export const PRIVATE_COMMENT_ERROR = "synthetic-private-comment-diagnostic";
export type CommentFixtureActor = "user" | "app" | "user-oauth" | "unknown-oauth";
export type CommentFixtureOutcome =
  | "success"
  | "http-401"
  | "http-403"
  | "http-429"
  | "http-307"
  | "forbidden"
  | "disconnect"
  | "invalid-receipt"
  | "missing-success"
  | "partial-success";
interface CommentFixtureOptions {
  resources?: boolean;
  estimate?: number | null;
  outcome?: CommentFixtureOutcome;
  unavailableReadback?: boolean;
  milestoneField?: boolean;
  issueProjection?: boolean;
  issueResponses?: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
}

/** External protocol fixture enforcing the selected credential and ordinary comment schema. */
export async function commentCreateFixture(
  actor: CommentFixtureActor = "user",
  options: CommentFixtureOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "linear-comment-create-"));
  const attempts: { transport: "mcp" | "native"; input: Record<string, unknown> }[] = [];
  const observed = {
    redirects: 0,
    readsAfterMutation: 0,
    authorizationMismatches: 0,
    tokenExchanges: 0,
  };
  const quota = { issueInputs: [] as Record<string, unknown>[], estimateReads: 0 };
  const active = new Set<Server>();
  const closingProtocols = new Set<Promise<void>>();
  const resources = {
    issueReads: 0,
    pageInputs: [] as Record<string, unknown>[],
    mutations: [] as Record<string, unknown>[],
  };
  const issue = {
    id: COMMENT_ISSUE_ID,
    identifier: "ENG-12",
    title: "Comment fixture",
    ...(options.issueProjection ? { status: "Todo", delegate: null } : {}),
    description: "Fixture body",
    ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
    ...(options.resources
      ? {
          priority: 3,
          estimate: options.estimate ?? null,
          labels: [
            { id: "5c55cf08-b826-4609-83d5-a86a09a5dfbc", name: "Bug" },
            { id: "fdd6e8ba-b160-45c2-a23d-e609b74287e5", name: "Urgent" },
          ],
        }
      : {}),
    url: `https://linear.app/${COMMENT_WORKSPACE}/issue/ENG-12/fixture`,
  };
  const comment = (input: Record<string, unknown>) => ({
    id: COMMENT_ID,
    body: input.body,
    user: { name: actor === "app" ? "Fixture app" : "Fixture user" },
    url: `${issue.url}#comment-${COMMENT_ID}`,
  });
  const tools: {
    name: string;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  }[] = [
    { name: "get_workspace", inputSchema: { type: "object", properties: {} } },
    {
      name: "get_issue",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          ...(options.issueProjection
            ? {
                fields: {
                  type: "array",
                  items: { enum: ["status", "delegate", "priority", "estimate"] },
                },
              }
            : {}),
        },
        required: ["id"],
      },
    },
    {
      name: "save_comment",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
  ];
  if (options.resources) {
    tools.push(
      {
        name: "list_issues",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50 },
            cursor: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "save_issue",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            priority: { type: "integer", minimum: 0, maximum: 4 },
            ...(options.issueProjection
              ? { state: { type: "string" }, delegate: { type: ["string", "null"] } }
              : {}),
            estimate: { type: ["number", "null"] },
            ...(options.milestoneField ? { milestone: { type: "string" } } : {}),
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    );
  }
  const http = createServer(async (request, response) => {
    try {
      if (request.url === "/token") {
        observed.tokenExchanges += 1;
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "synthetic-comment-key",
            token_type: "Bearer",
            scope: "read,comments:create",
            expires_in: 3600,
          }),
        );
        return;
      }
      const expectedAuthorization =
        actor === "user" && request.url === "/graphql"
          ? "synthetic-comment-key"
          : "Bearer synthetic-comment-key";
      if (request.headers.authorization !== expectedAuthorization) {
        observed.authorizationMismatches += 1;
        throw new Error("Unexpected fixture authorization");
      }
      if (request.url === "/redirected") {
        observed.redirects += 1;
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: { commentCreate: { success: true, comment: comment({}) } } }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      if (request.url === "/graphql") {
        let payload: unknown;
        if (body?.query?.startsWith("query ConnectionIdentity")) {
          payload = {
            data: {
              viewer: {
                id: "fixture-user",
                name: actor === "app" ? "Fixture app" : "Fixture user",
                app: actor === "app",
                organization: {
                  id: "fixture-organization",
                  name: "Fixture",
                  urlKey: COMMENT_WORKSPACE,
                },
              },
            },
          };
        } else if (options.issueProjection && body?.query?.startsWith("query IssueEstimate")) {
          quota.estimateReads++;
          payload = {
            data: {
              viewer: { organization: { urlKey: COMMENT_WORKSPACE } },
              issue: {
                id: COMMENT_ISSUE_ID,
                identifier: "ENG-12",
                estimate: 0,
                team: { organization: { urlKey: COMMENT_WORKSPACE } },
              },
            },
          };
        } else throw new Error("Unexpected native fixture operation");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
        return;
      }
      if (request.url !== "/mcp") throw new Error("Unexpected fixture endpoint");
      if (body?.method === "tools/call" && body.params?.name === "save_comment") {
        const outcome = options.outcome ?? "success";
        if (outcome === "disconnect" || outcome.startsWith("http-")) {
          attempts.push({ transport: "mcp", input: body.params.arguments ?? {} });
          if (outcome === "disconnect") {
            request.socket.destroy();
            return;
          }
          const status = Number(outcome.slice(5));
          response.writeHead(status, {
            "content-type": "application/json",
            ...(status === 307 ? { location: "/redirected" } : {}),
            ...(status === 429 ? { "retry-after": "37" } : {}),
          });
          response.end(JSON.stringify({ error: PRIVATE_COMMENT_ERROR }));
          return;
        }
      }
      const protocol = new Server(
        { name: "comment-fixture", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      protocol.setRequestHandler(CallToolRequestSchema, async (message) => {
        const input = message.params.arguments ?? {};
        let data: unknown;
        if (message.params.name === "get_workspace") {
          data = { url: `https://linear.app/${COMMENT_WORKSPACE}` };
        } else if (message.params.name === "get_issue") {
          quota.issueInputs.push({ ...input });
          if (options.resources) resources.issueReads += 1;
          if (attempts.length > 0) {
            observed.readsAfterMutation += 1;
            if (options.unavailableReadback) {
              return { isError: true, content: [{ type: "text", text: PRIVATE_COMMENT_ERROR }] };
            }
          }
          const identifier = String(input.id);
          if (options.issueResponses && Object.hasOwn(options.issueResponses, identifier)) {
            const fields = options.issueResponses[identifier];
            if (fields === null)
              return { isError: true, content: [{ type: "text", text: PRIVATE_COMMENT_ERROR }] };
            data = { ...issue, ...fields };
          } else {
            if (![issue.identifier, issue.id].includes(identifier))
              throw new Error("Unexpected fixture issue");
            data = issue;
          }
          if (options.issueProjection) {
            const selected = Array.isArray(input.fields)
              ? input.fields
              : ["status", "delegate", "priority"];
            data = Object.fromEntries(
              Object.entries(data as Record<string, unknown>).filter(
                ([key]) =>
                  ["id", "identifier", "url"].includes(key) ||
                  (key !== "estimate" && selected.includes(key)),
              ),
            );
          }
        } else if (options.resources && message.params.name === "list_issues") {
          resources.pageInputs.push({ ...input });
          if (input.cursor !== undefined && input.cursor !== COMMENT_PAGE_CURSOR)
            throw new Error("Unexpected resource fixture cursor");
          data =
            input.cursor === undefined
              ? { nodes: [issue], pageInfo: { hasNextPage: true, endCursor: COMMENT_PAGE_CURSOR } }
              : {
                  nodes: [
                    { ...issue, id: "898b5ccf-8dad-41de-a510-419d8d32e1f9", identifier: "ENG-13" },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                };
        } else if (options.resources && message.params.name === "save_issue") {
          if (![issue.identifier, issue.id].includes(String(input.id)))
            throw new Error("Unexpected resource fixture issue");
          resources.mutations.push({ ...input });
          if (typeof input.priority === "number") issue.priority = input.priority;
          data = issue;
        } else if (message.params.name === "save_comment") {
          if (![issue.identifier, issue.id].includes(String(input.issueId)))
            throw new Error("Unexpected comment parent");
          attempts.push({ transport: "mcp", input });
          if (options.outcome === "forbidden")
            return {
              isError: true,
              content: [{ type: "text", text: PRIVATE_COMMENT_ERROR }],
              structuredContent: { error: { code: "FORBIDDEN", message: PRIVATE_COMMENT_ERROR } },
            };
          data =
            options.outcome === "invalid-receipt"
              ? { body: input.body }
              : {
                  ...comment(input),
                  ...(options.outcome === "partial-success"
                    ? { errors: [{ message: PRIVATE_COMMENT_ERROR }] }
                    : {}),
                };
        } else throw new Error("Unexpected fixture tool");
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data as Record<string, unknown>,
        };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      active.add(protocol);
      response.once("close", () => {
        active.delete(protocol);
        const closing = protocol.close();
        closingProtocols.add(closing);
        void closing.finally(() => closingProtocols.delete(closing)).catch(() => undefined);
      });
      await protocol.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end("Fixture request failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    CODEX_HOME: join(directory, "codex"),
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    PI_SESSION_ID: "synthetic-comment-session",
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
    LINEAR_AXI_GRAPHQL_URL: `http://127.0.0.1:${address.port}/graphql`,
    LINEAR_AXI_TOKEN_FILE: join(directory, "existing-app-token.json"),
    LINEAR_AXI_OAUTH_CLIENT_ID: "synthetic-comment-client",
    LINEAR_AXI_OAUTH_AUTHORIZE_URL: `http://127.0.0.1:${address.port}/authorize`,
    LINEAR_AXI_OAUTH_TOKEN_URL: `http://127.0.0.1:${address.port}/token`,
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await Promise.allSettled([...active].map((server) => server.close()));
        http.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled(closingProtocols);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })());
  try {
    await writeFile(
      environment.LINEAR_AXI_TOKEN_FILE!,
      JSON.stringify({ accessToken: "synthetic-comment-key", expiresAt: Date.now() + 3600_000 }),
      { mode: 0o600 },
    );
    const manager = new NamedConnections({ env: environment });
    let selected;
    if (actor === "app" || actor === "user-oauth") {
      const pending = await manager.beginLogin({
        actor: actor === "app" ? "app" : "user",
        scopes: ["read", "comments:create"],
        method: "oauth",
        name: "Comment connection",
      });
      const state = new URL(pending.url).searchParams.get("state");
      selected = await manager.finishLogin({
        callbackUrl: `${pending.redirectUri}?code=synthetic-comment-code&state=${state}`,
      });
    } else {
      selected = await manager.importCredential({
        type: actor === "unknown-oauth" ? "oauth" : "api-key",
        token: "synthetic-comment-key",
        name: "Comment connection",
      });
    }
    environment.LINEAR_AXI_CONNECTION_ID = selected.connectionId;
    environment.LINEAR_AXI_AUTH_EPOCH = selected.epoch;
    await mkdir(join(directory, ".pi"), { recursive: true });
    const shim = join(directory, "axi.mjs");
    await writeFile(
      shim,
      `await import(${JSON.stringify(import.meta.resolve("#axi/bin.ts"))});\n`,
    );
    await writeFile(join(directory, ".pi", "linear.json"), JSON.stringify({ axiPath: shim }));
  } catch (error) {
    await close();
    throw error;
  }
  return {
    directory,
    environment,
    attempts,
    observed,
    quota,
    close,
    ...(options.resources ? { resources } : {}),
    async command(args: string[], overrides: NodeJS.ProcessEnv = {}) {
      try {
        const output = await execute(process.execPath, [cli, ...args], {
          cwd: directory,
          env: { ...environment, ...overrides },
          timeout: 15_000,
        });
        return { ...output, exitCode: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          exitCode: failure.code ?? 1,
        };
      }
    },
  };
}
