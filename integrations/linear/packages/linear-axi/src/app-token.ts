import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedConnection } from "./managed-connection.ts";
import { asRecord, isUnknownArray } from "./types.ts";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Explicit operator declaration; never inferred from the legacy token cache. */
export interface AppRenewalBinding {
  clientId: string;
  scopes: string[];
  /** Absent on old bindings; explicit re-enablement pins the configured endpoint. */
  endpoint?: string;
}
const renewableScopes = new Set([
  "read",
  "write",
  "issues:create",
  "comments:create",
  "app:assignable",
  "webhook",
]);

export function appRenewalScopes(value: unknown): string[] {
  const names = isUnknownArray(value) ? value : [];
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    !names.every((name): name is string => typeof name === "string" && renewableScopes.has(name))
  )
    throw new Error("LINEAR_AUTH_APP_RENEWAL_CONFIG");
  return [...names];
}
function clientCredentialsBody(
  clientId: string,
  clientSecret: string,
  scope: string,
): URLSearchParams {
  return new URLSearchParams({
    grant_type: "client_credentials",
    scope,
    client_id: clientId,
    client_secret: clientSecret,
  });
}
export interface AppTokenProviderOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  /** Non-secret operator scope config; explicit environment scopes take precedence. */
  scopePath?: string;
  connection?: ManagedConnection;
}

/** Provides native authorization from the selected connection, or unchanged legacy configuration. */
export class LinearAppTokenProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly cachePath: string;
  private readonly scopePath: string;
  private readonly connection?: ManagedConnection;

  constructor({
    env,
    fetchImpl = fetch,
    cachePath,
    scopePath,
    connection,
  }: AppTokenProviderOptions) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.connection = connection;
    this.cachePath = cachePath ?? env.LINEAR_AXI_TOKEN_FILE ?? defaultTokenPath(env);
    this.scopePath =
      scopePath ??
      env.LINEAR_AXI_APP_SCOPE_FILE ??
      join(
        env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
        "config",
        "linear-axi",
        "app-scope.json",
      );
  }

  async isManagedConnection(): Promise<boolean> {
    return (await this.connection?.isManaged()) ?? false;
  }
  /** Assert that a native operation still uses the selected connection acquired earlier. */
  async assertCurrentAuthorization(): Promise<void> {
    await this.connection?.assertEpoch();
  }
  async getAuthorization(forceRefresh = false): Promise<string> {
    const selected = await this.connection?.authorization(forceRefresh);
    return selected ?? `Bearer ${await this.getToken(forceRefresh)}`;
  }

  async getStorageAuthorization(forceRefresh = false): Promise<string> {
    const selected = await this.connection?.authorization(forceRefresh, "storage");
    return selected ?? this.getAuthorization(forceRefresh);
  }
  async getToken(forceRefresh = false): Promise<string> {
    const selected = await this.connection?.authorization(forceRefresh);
    if (selected !== undefined)
      return selected.startsWith("Bearer ") ? selected.slice(7) : selected;
    const configured = this.env.LINEAR_AXI_MCP_TOKEN ?? this.env.LINEAR_MCP_TOKEN;
    if (configured) return configured;

    if (!forceRefresh) {
      const cached = await this.readCache();
      if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    }

    const clientId = this.env.LINEAR_AXI_CLIENT_ID ?? this.env.LINEAR_CLIENT_ID;
    const clientSecret = this.env.LINEAR_AXI_CLIENT_SECRET ?? this.env.LINEAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Native App access requires LINEAR_AXI_MCP_TOKEN or LINEAR_AXI_CLIENT_ID and LINEAR_AXI_CLIENT_SECRET",
      );
    }

    const body = clientCredentialsBody(clientId, clientSecret, await this.requestedScope());
    const response = await this.fetchImpl(
      this.env.LINEAR_AXI_TOKEN_URL ?? "https://api.linear.app/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok) {
      const detail = payload.error_description ?? payload.error;
      throw new Error(
        `Linear app token request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!payload.access_token)
      throw new Error("Linear app token response did not include access_token");

    const expiresAt = Date.now() + Math.max(0, (payload.expires_in ?? 3600) * 1000);
    await this.writeCache({ accessToken: payload.access_token, expiresAt });
    return payload.access_token;
  }

  /** Reuse an existing installation without exchanging, refreshing or changing its grants. */
  async existingToken(): Promise<Readonly<CachedToken>> {
    const cached = await this.readCache();
    if (!cached || !Number.isFinite(cached.expiresAt) || cached.expiresAt <= Date.now() + 30_000)
      throw new Error("LINEAR_AUTH_APP_TOKEN_UNAVAILABLE");
    return cached;
  }

  /** Prepare only the declared grant. No HTTP, bearer override or legacy-cache writes. */
  async renewalRequest(expected?: AppRenewalBinding): Promise<{
    binding: AppRenewalBinding;
    body: URLSearchParams;
  }> {
    try {
      const clientId = this.env.LINEAR_AXI_CLIENT_ID ?? this.env.LINEAR_CLIENT_ID;
      const clientSecret = this.env.LINEAR_AXI_CLIENT_SECRET ?? this.env.LINEAR_CLIENT_SECRET;
      if (
        typeof clientId !== "string" ||
        !clientId.trim() ||
        clientId.length > 1024 ||
        /\s/u.test(clientId) ||
        typeof clientSecret !== "string" ||
        !clientSecret.trim() ||
        clientSecret.length > 32768 ||
        /[\x00-\x1f\x7f]/u.test(clientSecret)
      )
        throw new Error();
      const configured = await this.requestedScope(false);
      const scopes = appRenewalScopes(configured.split(/[ ,]+/u).filter(Boolean));
      if (
        expected &&
        (expected.clientId !== clientId ||
          expected.scopes.length !== scopes.length ||
          expected.scopes.some((scope) => !scopes.includes(scope)))
      )
        throw new Error();
      const binding = { clientId, scopes: expected ? [...expected.scopes] : scopes };
      return {
        binding,
        body: clientCredentialsBody(clientId, clientSecret, binding.scopes.join(",")),
      };
    } catch {
      throw new Error("LINEAR_AUTH_APP_RENEWAL_CONFIG");
    }
  }
  /** Cache association is local evidence only, not proof of the original grant scopes. */
  async matchesCachedToken(accessToken: string): Promise<boolean> {
    return (await this.readCache())?.accessToken === accessToken;
  }
  private async requestedScope(allowDefaults = true): Promise<string> {
    if (this.env.LINEAR_AXI_TOKEN_SCOPE !== undefined) return this.env.LINEAR_AXI_TOKEN_SCOPE;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.scopePath, "utf8"));
    } catch (error) {
      if (allowDefaults && (error as NodeJS.ErrnoException).code === "ENOENT")
        return "read,comments:create";
      throw new Error("LINEAR_INVALID_APP_SCOPE_CONFIG", { cause: error });
    }
    const scope = asRecord(value)?.scope;
    try {
      return appRenewalScopes(typeof scope === "string" ? scope.split(",") : undefined).join(",");
    } catch {
      throw new Error("LINEAR_INVALID_APP_SCOPE_CONFIG");
    }
  }
  async clearCache(): Promise<void> {
    if (await this.connection?.isManaged()) return;
    try {
      await rm(this.cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async readCache(): Promise<CachedToken | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.cachePath, "utf8"));
      const cache = asRecord(value);
      if (typeof cache?.accessToken !== "string" || typeof cache.expiresAt !== "number")
        return null;
      return { accessToken: cache.accessToken, expiresAt: cache.expiresAt };
    } catch {
      return null;
    }
  }

  private async writeCache(value: CachedToken): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(this.cachePath, 0o600);
  }
}

/** Native API clients share authorization but do not own the credential store. */
export interface NativeTokenProvider {
  getToken(forceRefresh?: boolean): Promise<string>;
  getAuthorization?(forceRefresh?: boolean): Promise<string>;
  getStorageAuthorization?(forceRefresh?: boolean): Promise<string>;
  assertCurrentAuthorization?(): Promise<void>;
}

export interface RefreshableNativeTokenProvider extends NativeTokenProvider {
  clearCache(): Promise<void>;
}

/** Keep old injected providers compatible while preserving managed key/OAuth header types. */
export async function authorizationHeader(
  provider: NativeTokenProvider,
  forceRefresh = false,
  target: "native" | "storage" = "native",
): Promise<string> {
  if (target === "storage" && typeof provider.getStorageAuthorization === "function")
    return provider.getStorageAuthorization(forceRefresh);
  return typeof provider.getAuthorization === "function"
    ? provider.getAuthorization(forceRefresh)
    : `Bearer ${await provider.getToken(forceRefresh)}`;
}
function defaultTokenPath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "linear-axi", "app-token.json");
}
