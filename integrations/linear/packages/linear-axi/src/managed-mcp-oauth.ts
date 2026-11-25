import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractData } from "./lib/mcp-tools.ts";
import { isRecord, isUnknownArray, type InputRecord } from "./types.ts";
import type { ConnectionIdentity } from "./managed-connection.ts";

/** Public registration/discovery data for this installation, never the legacy OAuth cache. */
export interface McpOAuthSession {
  serverUrl: string;
  issuer: string;
  resource: string;
  metadata: NonNullable<OAuthServerInfo["authorizationServerMetadata"]> & {
    authorization_response_iss_parameter_supported?: boolean;
  };
  client: OAuthClientInformationMixed;
}
function fail(code: string): never {
  throw new Error(code);
}
function object(value: unknown): InputRecord {
  if (!isRecord(value)) fail("LINEAR_AUTH_INVALID_RESPONSE");
  return value;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    fail("LINEAR_AUTH_INVALID_RESPONSE");
  return value;
}
function serverURL(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      (url.protocol === "https:" && url.hostname === "mcp.linear.app" && !url.port) ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    fail("LINEAR_AUTH_ENDPOINT_INVALID");
  return url;
}
function sameOrigin(value: string, origin: string): URL {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.hash)
    fail("LINEAR_AUTH_ENDPOINT_INVALID");
  return url;
}
function limitedFetch(fetchImpl: typeof fetch, origin: string): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sameOrigin(input instanceof Request ? input.url : String(input), origin);
    return fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  };
}
/** Revalidate persisted metadata before it can select a token destination. */
export function validateMcpOAuthSession(value: unknown): McpOAuthSession {
  const session = object(value);
  const server = serverURL(text(session.serverUrl));
  sameOrigin(text(session.issuer), server.origin);
  const resource = sameOrigin(text(session.resource), server.origin);
  if (
    resource.search ||
    !(
      resource.pathname === "/" ||
      server.pathname === resource.pathname ||
      server.pathname.startsWith(resource.pathname.replace(/\/$/u, "") + "/")
    )
  )
    fail("LINEAR_AUTH_ENDPOINT_INVALID");
  const metadata = object(session.metadata);
  if (metadata.issuer !== session.issuer) fail("LINEAR_AUTH_ENDPOINT_INVALID");
  for (const name of ["authorization_endpoint", "token_endpoint", "registration_endpoint"])
    sameOrigin(text(metadata[name]), server.origin);
  if (
    !isUnknownArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256") ||
    !isUnknownArray(metadata.token_endpoint_auth_methods_supported) ||
    !metadata.token_endpoint_auth_methods_supported.includes("none")
  )
    fail("LINEAR_AUTH_ENDPOINT_INVALID");
  const client = object(session.client);
  text(client.client_id);
  if (
    client.client_secret !== undefined ||
    client.token_endpoint_auth_method !== "none" ||
    client.issuer !== session.issuer
  )
    fail("LINEAR_AUTH_ENDPOINT_INVALID");
  return value as McpOAuthSession;
}
export function assertMcpOAuthTarget(session: McpOAuthSession, target: string): void {
  validateMcpOAuthSession(session);
  const url = new URL(target),
    selected = new URL(session.serverUrl);
  if (url.href !== selected.href) fail("LINEAR_AUTH_ENDPOINT_INVALID");
}
export async function beginMcpOAuth(input: {
  serverUrl: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  fetchImpl: typeof fetch;
}): Promise<{ url: string; verifier: string; session: McpOAuthSession }> {
  try {
    if (input.scopes.some((scope) => !["read", "write"].includes(scope)))
      fail("LINEAR_AUTH_INVALID_SCOPE");
    const server = serverURL(input.serverUrl);
    const fetchFn = limitedFetch(input.fetchImpl, server.origin);
    const info = await discoverOAuthServerInfo(server, { fetchFn });
    const metadata = info.authorizationServerMetadata;
    if (!metadata || !info.resourceMetadata) fail("LINEAR_AUTH_ENDPOINT_INVALID");
    // Validate destinations before registering; discovery itself carries no credential.
    const provisional: McpOAuthSession = {
      serverUrl: server.href,
      issuer: info.authorizationServerUrl,
      resource: info.resourceMetadata.resource,
      metadata,
      client: {
        client_id: "pending",
        token_endpoint_auth_method: "none",
        issuer: info.authorizationServerUrl,
      },
    };
    validateMcpOAuthSession(provisional);
    const registration = await registerClient(info.authorizationServerUrl, {
      metadata,
      fetchFn,
      scope: input.scopes.join(" "),
      clientMetadata: {
        client_name: "linear-axi",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    if (registration.token_endpoint_auth_method !== "none") fail("LINEAR_AUTH_ENDPOINT_INVALID");
    const session: McpOAuthSession = {
      ...provisional,
      client: {
        client_id: registration.client_id,
        token_endpoint_auth_method: "none",
        issuer: info.authorizationServerUrl,
      },
    };
    validateMcpOAuthSession(session);
    const started = await startAuthorization(session.issuer, {
      metadata,
      clientInformation: session.client,
      redirectUrl: input.redirectUri,
      state: input.state,
      scope: input.scopes.join(" "),
      resource: session.resource,
    });
    sameOrigin(started.authorizationUrl.href, server.origin);
    return { url: started.authorizationUrl.href, verifier: started.codeVerifier, session };
  } catch {
    fail("LINEAR_AUTH_MCP_LOGIN_FAILED");
  }
}
function checkTokens(value: OAuthTokens): OAuthTokens {
  if (value.token_type.toLowerCase() !== "bearer") fail("LINEAR_AUTH_INVALID_RESPONSE");
  return value;
}
export async function finishMcpOAuth(
  session: McpOAuthSession,
  input: { code: string; verifier: string; redirectUri: string; fetchImpl: typeof fetch },
): Promise<OAuthTokens> {
  try {
    validateMcpOAuthSession(session);
    return checkTokens(
      await exchangeAuthorization(session.issuer, {
        metadata: session.metadata,
        clientInformation: session.client,
        authorizationCode: input.code,
        codeVerifier: input.verifier,
        redirectUri: input.redirectUri,
        resource: session.resource,
        fetchFn: limitedFetch(input.fetchImpl, new URL(session.serverUrl).origin),
      }),
    );
  } catch {
    fail("LINEAR_AUTH_EXCHANGE_FAILED");
  }
}
export async function refreshMcpOAuth(
  session: McpOAuthSession,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<OAuthTokens> {
  try {
    validateMcpOAuthSession(session);
    return checkTokens(
      await refreshAuthorization(session.issuer, {
        metadata: session.metadata,
        clientInformation: session.client,
        refreshToken,
        resource: session.resource,
        fetchFn: limitedFetch(fetchImpl, new URL(session.serverUrl).origin),
      }),
    );
  } catch {
    fail("LINEAR_AUTH_EXCHANGE_FAILED");
  }
}
/** This read-only probe authenticates with exactly the selected token, without any OAuth provider. */
export async function mcpConnectionIdentity(
  session: McpOAuthSession,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<ConnectionIdentity> {
  validateMcpOAuthSession(session);
  const transport = new StreamableHTTPClientTransport(new URL(session.serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: limitedFetch(fetchImpl, new URL(session.serverUrl).origin),
  });
  const client = new Client({ name: "linear-axi", version: "0.1.0" });
  try {
    await client.connect(transport);
    const userResult = await client.callTool({ name: "get_user", arguments: { query: "me" } });
    const workspaceResult = await client.callTool({ name: "get_workspace", arguments: {} });
    if (userResult.isError || workspaceResult.isError) fail("LINEAR_AUTH_IDENTITY_UNAVAILABLE");
    const user = object(extractData(userResult)),
      workspace = object(extractData(workspaceResult));
    const url = new URL(text(workspace.url));
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)
    )
      fail("LINEAR_AUTH_IDENTITY_UNAVAILABLE");
    return {
      id: text(user.id),
      name: text(user.name),
      ...(user.email ? { email: text(user.email) } : {}),
      workspace: {
        id: text(workspace.id),
        name: text(workspace.name),
        slug: url.pathname.replace(/^\/|\/$/gu, ""),
      },
    };
  } catch {
    return fail("LINEAR_AUTH_IDENTITY_UNAVAILABLE");
  } finally {
    try {
      await client.close();
    } catch {
      /* Closing cannot replace the safe identity result. */
    }
  }
}
