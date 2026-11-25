import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isLinearOperation, isReadOnlyOperation } from "./lib/operation-catalog.ts";
import { mcpToolFailure } from "./lib/mcp-error.ts";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  asRecord,
  isUnknownArray,
  type InputRecord,
  type McpResult,
  type McpTool,
} from "./types.ts";
import type { ManagedConnection } from "./managed-connection.ts";
import type { LinearPreflightCache } from "./preflight-cache.ts";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

// Classify our outgoing protocol envelope, never remote readOnlyHint annotations.
function mutationRequest(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = isUnknownArray(parsed) ? parsed : [parsed];
    return messages.some((value) => {
      const message = asRecord(value);
      if (message?.method !== "tools/call") return false;
      const name = asRecord(message.params)?.name;
      return (
        name !== "get_workspace" &&
        !(typeof name === "string" && isLinearOperation(name) && isReadOnlyOperation(name))
      );
    });
  } catch {
    return false;
  }
}
interface ClientOptions {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  authStorePath?: string;
  connection?: ManagedConnection;
  preflightCache?: LinearPreflightCache;
}

interface OAuthStore {
  state?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export class LinearMcpClient {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  authStorePath?: string;
  authProvider: LinearOAuthProvider | null;
  client: Client | null = null;
  transport: StreamableHTTPClientTransport | null = null;

  private readonly connection?: ManagedConnection;
  private readonly preflightCache?: LinearPreflightCache;
  private tools?: Tool[];
  private readonly outputValidator = new AjvJsonSchemaValidator();

  constructor({ url, token, fetchImpl, authStorePath, connection, preflightCache }: ClientOptions) {
    this.preflightCache = preflightCache;
    this.connection = connection;
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.authStorePath = authStorePath;
    this.authProvider = token ? null : new LinearOAuthProvider({ storePath: authStorePath });
  }

  private async transportFetch(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> {
    const mutation = mutationRequest(init?.body);
    const options = mutation ? { ...init, redirect: "manual" as const } : init;
    const response = this.preflightCache
      ? await this.preflightCache.fetch(input, options, this.fetchImpl ?? fetch)
      : await (this.fetchImpl ?? fetch)(input, options);
    if (!mutation || response.ok) return response;
    // A Response would let the SDK refresh/upscope and resend this mutation.
    const failure = new StreamableHTTPError(response.status, "LINEAR_MCP_REQUEST_REJECTED");
    try {
      await response.body?.cancel();
    } catch {
      Object.defineProperty(failure, "cause", {
        value: new Error("LINEAR_RESPONSE_CLEANUP_FAILED"),
      });
    }
    throw failure;
  }
  async connect(): Promise<void> {
    const selected = await this.connection?.bearerToken(false, this.url);
    const token = selected ?? this.token;
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
      authProvider: token ? undefined : (this.authProvider ?? undefined),
      fetch: (input, init) => this.transportFetch(input, init),
    });
    this.client = new Client({ name: "linear-axi", version: "0.1.0" });
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      if (!token && this.authProvider?.authorizationUrl) {
        throw Object.assign(new Error("Linear MCP OAuth authorization required"), {
          authorizationUrl: this.authProvider.authorizationUrl,
        });
      }
      throw error;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const load = async () => {
      const client = await this.connectedClient();
      return (await client.listTools()).tools;
    };
    const tools = this.preflightCache
      ? await this.preflightCache.get(
          "tools",
          load,
          (value): value is Tool[] =>
            Array.isArray(value) &&
            value.length <= 256 &&
            ListToolsResultSchema.safeParse({ tools: value }).success,
        )
      : await load();
    // Compile cached schemas before any requested operation can be dispatched.
    for (const tool of tools)
      if (tool.outputSchema) this.outputValidator.getValidator(tool.outputSchema);
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: InputRecord): Promise<McpResult> {
    const metadata = this.tools?.find((tool) => tool.name === name);
    if (metadata?.execution?.taskSupport === "required")
      throw new McpError(ErrorCode.InvalidRequest, "This tool requires task-based execution");
    const client = await this.connectedClient();
    // The SDK callTool validator also applies success schemas to isError payloads.
    // Validate the protocol envelope here, then validate only successful tool output below.
    const result = await client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
    if (result.isError && this.preflightCache) {
      const failure = mcpToolFailure("OPERATION", result);
      if (failure.reason === "RATE_LIMITED")
        await this.preflightCache.rateLimited(this.url, failure.rateLimit ?? {});
    }
    // A fresh SDK client has not seen tools/list when metadata came from disk.
    // Preserve its output-schema contract using the SDK's public validator.
    if (metadata?.outputSchema && !result.isError) {
      if (!result.structuredContent)
        throw new McpError(ErrorCode.InvalidRequest, "Tool response is missing structured content");
      const validation = this.outputValidator.getValidator(metadata.outputSchema)(
        result.structuredContent,
      );
      if (!validation.valid)
        throw new McpError(ErrorCode.InvalidParams, "Invalid structured tool response");
    }
    return result;
  }

  async finishAuth(code: string): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      authProvider: this.authProvider ?? undefined,
      fetch: this.fetchImpl,
    });
    await this.transport.finishAuth(code);
  }

  async logoutAuth(): Promise<{ removed: boolean; tokenConfigured: boolean }> {
    const provider =
      this.authProvider ?? new LinearOAuthProvider({ storePath: this.authStorePath });
    return { removed: await provider.deleteStore(), tokenConfigured: Boolean(this.token) };
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  private async connectedClient(): Promise<Client> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new Error("Linear MCP client is not connected");
    return client;
  }

  async ensureConnected(): Promise<void> {
    await this.connection?.assertEpoch();
    if (!this.client) await this.connect();
    // Connection initialization may await network I/O while another process signs out.
    await this.connection?.assertEpoch();
  }
}

export class LinearOAuthProvider implements OAuthClientProvider {
  storePath: string;
  authorizationUrl: string | null = null;

  constructor({ storePath }: { storePath?: string } = {}) {
    this.storePath = storePath ?? defaultAuthStorePath();
  }

  get redirectUrl(): string {
    return "http://127.0.0.1:14566/oauth/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "linear-axi",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  async state(): Promise<string> {
    const store = await this.readStore();
    if (store.state) return store.state;
    const state = randomBytes(24).toString("base64url");
    await this.updateStore({ state });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.readStore()).clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    await this.updateStore({ clientInformation: value });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readStore()).tokens;
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    await this.updateStore({ tokens: value });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url.toString();
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.updateStore({ codeVerifier: value });
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.readStore()).codeVerifier;
    if (!value) throw new Error("No OAuth code verifier saved");
    return value;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    const store = await this.readStore();
    if (scope === "all" || scope === "client") delete store.clientInformation;
    if (scope === "all" || scope === "tokens") delete store.tokens;
    if (scope === "all" || scope === "verifier") {
      delete store.codeVerifier;
      delete store.state;
    }
    await this.writeStore(store);
  }

  async deleteStore(): Promise<boolean> {
    try {
      await rm(this.storePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async readStore(): Promise<OAuthStore> {
    try {
      const value: unknown = JSON.parse(await readFile(this.storePath, "utf8"));
      return asRecord(value) ?? {};
    } catch {
      return {};
    }
  }

  async updateStore(patch: Partial<OAuthStore>): Promise<void> {
    await this.writeStore({ ...(await this.readStore()), ...patch });
  }

  async writeStore(store: OAuthStore): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.storePath, 0o600);
  }
}

function defaultAuthStorePath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "linear-axi",
    "oauth.json",
  );
}
