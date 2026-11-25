/// <reference types="node" />
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { decode } from "@toon-format/toon-v4";
import { NamedConnections } from "#axi/named-connections.ts";
import { LinearOAuthProvider } from "#axi/mcp.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(import.meta.resolve("#axi/bin.ts"));
const projectId = "3e628084-1d02-49d4-8654-2f28baa4fb70";
const workspace = "request-count-fixture";
export const PRIVATE_RATE_LIMIT_BODY = "private-rate-limit-body-never-exposed";
const project = {
  id: projectId,
  name: "Request count fixture",
  url: `https://linear.app/${workspace}/project/request-count-fixture`,
};
const tools: Tool[] = [
  {
    name: "get_workspace",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_project",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "save_comment",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" }, body: { type: "string" } },
      required: ["issueId", "body"],
      additionalProperties: false,
    },
  },
];

export interface RequestCounts {
  toolsList: number;
  workspace: number;
  project: number;
  initialize: number;
  initialized: number;
  httpRequests: number;
  mutationAttempts: number;
  nativeRequests: number;
  oauthRequests: number;
  oauthRequestsAfterFailure: number;
  redirectedMutationRequests: number;
  mutations: number;
}

/** Exercise the SDK protocol and actual CLI; replace only the external Linear service. */
export async function createMcpRequestCountFixture(
  options: {
    nativeQuotaHeaders?: boolean;
    legacyOAuth?: boolean;
    mutationFailure?: 401 | 403 | 307;
    mutationToolError?: Record<string, unknown>;
    mutationToolErrorStructured?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "linear-request-count-"));
  const counts: RequestCounts = {
    toolsList: 0,
    workspace: 0,
    project: 0,
    initialize: 0,
    initialized: 0,
    httpRequests: 0,
    mutationAttempts: 0,
    nativeRequests: 0,
    oauthRequests: 0,
    oauthRequestsAfterFailure: 0,
    redirectedMutationRequests: 0,
    mutations: 0,
  };
  const projectInputs: Record<string, unknown>[] = [];
  const active = new Set<Server>();
  let limitedOperation: "get_project" | "save_comment" | undefined;
  let mutationFailureUsed = false;
  let lastRateLimitResetAt = 0;
  const outputRecords: string[] = [];
  const http = createServer(async (request, response) => {
    counts.httpRequests++;
    let protocol: Server | undefined;
    try {
      const pathname = new URL(request.url ?? "/", endpoint).pathname;
      if (
        pathname.startsWith("/.well-known/") ||
        ["/token", "/register", "/authorize"].includes(pathname)
      ) {
        counts.oauthRequests++;
        if (mutationFailureUsed) counts.oauthRequestsAfterFailure++;
        request.resume();
        const origin = new URL(endpoint).origin;
        response.writeHead(pathname === "/register" ? 201 : 200, {
          "content-type": "application/json",
        });
        if (pathname.includes("oauth-protected-resource")) {
          response.end(
            JSON.stringify({
              resource: endpoint,
              authorization_servers: [origin],
              bearer_methods_supported: ["header"],
              scopes_supported: ["read", "write"],
            }),
          );
        } else if (pathname === "/token") {
          response.end(
            JSON.stringify({
              access_token: "synthetic-refreshed-key",
              token_type: "Bearer",
              refresh_token: "synthetic-refreshed-refresh-key",
              expires_in: 3600,
              scope: "read write",
            }),
          );
        } else if (pathname === "/register") {
          response.end(
            JSON.stringify({
              client_id: "synthetic-client",
              client_secret: "synthetic-client-secret",
              redirect_uris: ["http://127.0.0.1:14566/oauth/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "client_secret_post",
            }),
          );
        } else {
          response.end(
            JSON.stringify({
              issuer: origin,
              authorization_endpoint: origin + "/authorize",
              token_endpoint: origin + "/token",
              registration_endpoint: origin + "/register",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["client_secret_post"],
              code_challenge_methods_supported: ["S256"],
              scopes_supported: ["read", "write"],
            }),
          );
        }
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      // Only protocol method names are counted; authorization headers and arguments are not recorded.
      if (body?.method === "initialize") counts.initialize++;
      if (body?.method === "notifications/initialized") counts.initialized++;
      if (pathname === "/mutation-redirect") counts.redirectedMutationRequests++;
      if (
        body?.method === "tools/call" &&
        body.params?.name === "save_comment" &&
        options.mutationFailure &&
        !mutationFailureUsed
      ) {
        mutationFailureUsed = true;
        counts.mutationAttempts++;
        const status = options.mutationFailure;
        const origin = new URL(endpoint).origin;
        response.writeHead(status, {
          "content-type": "text/plain",
          ...(status === 401
            ? {
                "www-authenticate":
                  'Bearer resource_metadata="' +
                  origin +
                  '/.well-known/oauth-protected-resource/mcp"',
              }
            : status === 403
              ? {
                  "www-authenticate":
                    'Bearer error="insufficient_scope", scope="read write", resource_metadata="' +
                    origin +
                    '/.well-known/oauth-protected-resource/mcp"',
                }
              : { location: origin + "/mutation-redirect" }),
        });
        response.end(PRIVATE_RATE_LIMIT_BODY);
        return;
      }
      const native = request.url === "/graphql";
      if (
        native &&
        typeof body?.query === "string" &&
        body.query.startsWith("query ConnectionIdentity")
      ) {
        counts.nativeRequests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: {
              viewer: {
                id: "fixture-user",
                name: "Fixture user",
                email: "fixture@example.test",
                organization: { id: "fixture-organization", name: "Fixture", urlKey: workspace },
              },
            },
          }),
        );
        return;
      }
      if (native || (body?.method === "tools/call" && body.params?.name === limitedOperation)) {
        if (native) counts.nativeRequests++;
        else {
          if (limitedOperation === "get_project") counts.project++;
          else counts.mutationAttempts++;
          limitedOperation = undefined;
        }
        lastRateLimitResetAt = Date.now() + 60_000;
        response.writeHead(native ? 400 : 429, {
          "content-type": native ? "application/json" : "text/plain",
          "retry-after": "60",
          ...(!native || options.nativeQuotaHeaders !== false
            ? {
                "x-ratelimit-requests-limit": "2500",
                "x-ratelimit-requests-remaining": "0",
                "x-ratelimit-requests-reset": String(lastRateLimitResetAt),
              }
            : {}),
        });
        response.end(
          native
            ? JSON.stringify({
                errors: [{ message: PRIVATE_RATE_LIMIT_BODY, extensions: { code: "RATELIMITED" } }],
              })
            : PRIVATE_RATE_LIMIT_BODY,
        );
        return;
      }
      protocol = new Server(
        { name: "request-count-fixture", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      protocol.setRequestHandler(ListToolsRequestSchema, async () => {
        counts.toolsList++;
        await delay(25);
        return {
          tools: options.mutationToolErrorStructured
            ? tools.map((tool) =>
                tool.name === "save_comment"
                  ? {
                      ...tool,
                      outputSchema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"],
                      },
                    }
                  : tool,
              )
            : tools,
        };
      });
      protocol.setRequestHandler(CallToolRequestSchema, async (message) => {
        let data: Record<string, unknown>;
        if (message.params.name === "get_workspace") {
          counts.workspace++;
          await delay(25);
          data = { url: `https://linear.app/${workspace}` };
        } else if (message.params.name === "get_project") {
          counts.project++;
          projectInputs.push({ ...message.params.arguments });
          if (message.params.arguments?.query !== projectId)
            throw new Error("Unexpected fixture target");
          data = project;
        } else if (message.params.name === "save_comment") {
          counts.mutationAttempts++;
          if (options.mutationToolError)
            return {
              isError: true,
              ...(options.mutationToolErrorStructured
                ? { structuredContent: options.mutationToolError }
                : {}),
              content: [{ type: "text", text: JSON.stringify(options.mutationToolError) }],
            };
          counts.mutations++;
          data = {
            id: "b5d757b6-4c11-4ccd-8d0b-d939e06426d8",
            body: message.params.arguments?.body,
          };
        } else {
          throw new Error("Unexpected fixture operation");
        }
        return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      active.add(protocol);
      const connected = protocol;
      response.once("close", () => {
        active.delete(connected);
        void connected.close().catch(() => undefined);
      });
      await protocol.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Fixture request failed" },
        }),
      );
      if (protocol) {
        active.delete(protocol);
        await protocol.close().catch(() => undefined);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    CODEX_HOME: join(directory, "codex"),
  };
  Object.assign(env, {
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    LINEAR_AXI_CONNECTION_FILE: join(directory, "connection.json"),
    LINEAR_AXI_MCP_URL: endpoint,
    LINEAR_AXI_GRAPHQL_URL: `http://127.0.0.1:${address.port}/graphql`,
  });
  const close = async () => {
    await Promise.allSettled([...active].map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  };
  const manager = new NamedConnections({
    env,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              id: "fixture-user",
              name: "Fixture user",
              organization: { id: "fixture-organization", name: "Fixture", urlKey: workspace },
            },
          },
        }),
      ),
  });
  const input = join(directory, "project-input.json");
  try {
    if (options.legacyOAuth) {
      env.LINEAR_AXI_AUTH_FILE = join(directory, "synthetic-legacy-oauth.json");
      const provider = new LinearOAuthProvider({ storePath: env.LINEAR_AXI_AUTH_FILE });
      await provider.saveClientInformation({
        client_id: "synthetic-client",
        client_secret: "synthetic-client-secret",
      });
      await provider.saveTokens({
        access_token: "synthetic-request-count-key",
        token_type: "Bearer",
        refresh_token: "synthetic-refresh-key",
        expires_in: 3600,
        scope: "read write",
      });
    } else {
      const connection = await manager.importCredential({
        type: "api-key",
        token: "synthetic-request-count-key",
        name: "Work",
      });
      env.LINEAR_AXI_CONNECTION_ID = connection.connectionId;
    }
    await writeFile(input, JSON.stringify({ query: projectId }), { mode: 0o600 });
  } catch (error) {
    await close();
    throw error;
  }

  async function command(args: string[]) {
    const output = await execute(process.execPath, [cli, ...args], {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    outputRecords.push(output.stdout, output.stderr);
    return decode(output.stdout) as Record<string, unknown>;
  }
  return {
    environment: env,
    directory,
    command,
    projectInputs,
    snapshot: (): RequestCounts => ({ ...counts }),
    rateLimitNext(operation: "get_project" | "save_comment" = "get_project") {
      if (limitedOperation) throw new Error("A fixture rate-limit response is already pending");
      limitedOperation = operation;
    },
    rateLimitResetAt: () => lastRateLimitResetAt,
    commandOutput: () => outputRecords.join("\n"),
    async readNativeWorkflow() {
      const filename = join(directory, "workflow-input.json");
      await writeFile(filename, JSON.stringify({ id: projectId }), { mode: 0o600 });
      const result = await command([
        "resources",
        "invoke",
        "get_workflow_skill",
        "--workspace",
        workspace,
        "--input-file",
        filename,
      ]);
      return result.invocation as Record<string, unknown>;
    },
    async writeComment() {
      const filename = join(directory, "comment-input.json");
      await writeFile(
        filename,
        JSON.stringify({ issueId: projectId, body: "Synthetic fixture comment" }),
        { mode: 0o600 },
      );
      const result = await command([
        "resources",
        "invoke",
        "save_comment",
        "--workspace",
        workspace,
        "--input-file",
        filename,
      ]);
      return result.invocation as Record<string, unknown>;
    },
    async readProject() {
      const capabilities = await command(["resources", "capabilities", "--workspace", workspace]);
      const result = await command([
        "resources",
        "invoke",
        "get_project",
        "--workspace",
        workspace,
        "--input-file",
        input,
      ]);
      return { capabilities, invocation: result.invocation as Record<string, unknown> };
    },
    projectId,
    workspace,
    close,
  };
}

export function usefulMethodCounts(counts: RequestCounts) {
  return { toolsList: counts.toolsList, workspace: counts.workspace, project: counts.project };
}

export function subtractCounts(after: RequestCounts, before: RequestCounts): RequestCounts {
  const difference = { ...after };
  for (const key of Object.keys(difference) as Array<keyof RequestCounts>) {
    difference[key] -= before[key];
  }
  return difference;
}
