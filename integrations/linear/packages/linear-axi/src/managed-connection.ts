import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, unlinkSync } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  beginMcpOAuth,
  finishMcpOAuth,
  refreshMcpOAuth,
  mcpConnectionIdentity,
  validateMcpOAuthSession,
  assertMcpOAuthTarget,
} from "./managed-mcp-oauth.ts";
import type { McpOAuthSession } from "./managed-mcp-oauth.ts";
import { resourceOperationFailure } from "./lib/resource-failure.ts";
import { LinearAppTokenProvider, appRenewalScopes } from "./app-token.ts";
import type { AppRenewalBinding } from "./app-token.ts";
import { assertWindowsPrivatePath } from "./windows-private-path.ts";
import { isRecord, isUnknownArray, type InputRecord } from "./types.ts";

export type CredentialType = "api-key" | "oauth";
export type ConnectionActor = "user" | "app";
export interface ConnectionIdentity {
  id: string;
  name: string;
  email?: string;
  workspace: { id: string; slug: string; name: string };
}
export type ConnectionMethod = "mcp-oauth" | "user-oauth" | "app-oauth" | "api-key" | "oauth-token";
export interface SavedConnection extends Omit<ConnectionStatus, "connections"> {
  connectionId: string;
  name: string;
  method: ConnectionMethod;
}
export interface ConnectionStatus {
  connectionId?: string;
  name?: string;
  method?: ConnectionMethod;
  defaultConnectionId?: string | null;
  connections?: SavedConnection[];
  state: "legacy" | "signed-out" | "connected" | "expired" | "error";
  epoch: string;
  credentialType?: CredentialType;
  actor?: ConnectionActor;
  identity?: ConnectionIdentity;
  scopes?: string[];
  capabilities: {
    mcp: boolean;
    native: boolean;
    storage: boolean;
    refresh: boolean;
    revoke: boolean;
  };
}
interface Credential {
  type: CredentialType;
  accessToken: string;
  refreshToken?: string;
  appRenewal?: AppRenewalBinding;
  expiresAt?: number;
  clientId?: string;
  actor?: ConnectionActor;
  scopes: string[];
  identity: ConnectionIdentity;
  mcp?: McpOAuthSession;
  native?: boolean;
}
interface PendingLogin {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  actor: ConnectionActor;
  scopes: string[];
  expiresAt: number;
  mcp?: McpOAuthSession;
}
interface Store {
  version: 1;
  epoch: string;
  state: "signed-out" | "connected";
  credential?: Credential;
  pending?: PendingLogin;
}
export interface ManagedConnectionOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}
export const MAX_CONNECTION_STORE_BYTES = 128 * 1024;
const NONE = { mcp: false, native: false, storage: false, refresh: false, revoke: false };
const SCOPES = new Set([
  "read",
  "write",
  "issues:create",
  "comments:create",
  "timeSchedule:write",
  "admin",
  "app:assignable",
  "webhook",
  "app:mentionable",
  "customer:read",
  "customer:write",
  "initiative:read",
  "initiative:write",
]);
function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): InputRecord {
  if (!isRecord(value)) fail("LINEAR_AUTH_INVALID_RESPONSE");
  return value;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    /[\x00-\x1f]/u.test(value)
  )
    fail("LINEAR_AUTH_INVALID_RESPONSE");
  return value;
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 32768 ||
    /[^\x21-\x7e]/u.test(value)
  )
    fail("LINEAR_AUTH_INVALID_CREDENTIAL");
  return value;
}
function scopes(value: unknown, actor?: ConnectionActor): string[] {
  const names = isUnknownArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[ ,]+/u).filter(Boolean)
      : [];
  if (
    !names.every((n): n is string => typeof n === "string" && SCOPES.has(n)) ||
    new Set(names).size !== names.length ||
    (actor === "app" && names.includes("admin"))
  )
    fail("LINEAR_AUTH_INVALID_SCOPE");
  return names;
}
function identity(value: unknown): ConnectionIdentity {
  const user = record(value);
  const organization = record(user.organization);
  return {
    id: text(user.id),
    name: text(user.name),
    ...(typeof user.email === "string" && user.email ? { email: text(user.email) } : {}),
    workspace: {
      id: text(organization.id),
      slug: text(organization.urlKey),
      name: text(organization.name),
    },
  };
}
function safeStatus(store?: Store): ConnectionStatus {
  if (!store) return { state: "legacy", epoch: "legacy", capabilities: { ...NONE } };
  const c = store.credential;
  if (store.state !== "connected" || !c)
    return { state: "signed-out", epoch: store.epoch, capabilities: { ...NONE } };
  const expired = c.expiresAt !== undefined && c.expiresAt <= Date.now();
  const who = c.identity;
  const safeIdentity = {
    id: who.id,
    name: who.name,
    ...(who.email ? { email: who.email } : {}),
    workspace: { id: who.workspace.id, slug: who.workspace.slug, name: who.workspace.name },
  };
  return {
    state: expired ? "expired" : "connected",
    epoch: store.epoch,
    credentialType: c.type,
    ...(c.actor ? { actor: c.actor } : {}),
    identity: safeIdentity,
    scopes: [...c.scopes],
    capabilities: {
      mcp: !expired,
      native: !expired && c.native !== false,
      // No private-file authorization was proven by the MCP/native identity probes.
      storage: !expired && !c.mcp && c.native !== false,
      refresh: Boolean(c.refreshToken || c.appRenewal),
      revoke: c.type === "oauth" && !c.mcp,
    },
  };
}
function endpoint(value: string | undefined, fallback: string): string {
  const url = new URL(value ?? fallback);
  const normal = new URL(fallback);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      (url.protocol === "https:" && url.hostname === normal.hostname) ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    fail("LINEAR_AUTH_ENDPOINT_INVALID");
  return url.href;
}
async function safePath(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail("LINEAR_AUTH_STORE_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function windowsPrivate(path: string): Promise<void> {
  try {
    await assertWindowsPrivatePath(path);
  } catch {
    fail("LINEAR_AUTH_STORE_UNSAFE");
  }
}
/** Shared no-symlink path check for private, principal-scoped local metadata. */
export { safePath as assertSafePrivatePath };
/** Own one explicit connection; absent state alone retains the legacy operator configuration. */
export class ManagedConnection {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private boundEpoch?: string;
  constructor({ env, fetchImpl = fetch }: ManagedConnectionOptions) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    const root = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const selected =
      env.LINEAR_AXI_CONNECTION_FILE ?? join(root, "config", "linear-axi", "connection.json");
    this.path = isAbsolute(selected) ? selected : resolve(selected);
    this.boundEpoch = env.LINEAR_AXI_AUTH_EPOCH;
  }
  async status(verifyConnection = false): Promise<ConnectionStatus> {
    const store = await this.read();
    if (verifyConnection && store?.state === "connected" && store.credential) {
      const selected = await this.selectedCredential();
      if (!selected) fail("LINEAR_AUTH_REQUIRED");
      const checked = selected.mcp
        ? await mcpConnectionIdentity(selected.mcp, selected.accessToken, this.fetchImpl)
        : await this.verify(
            selected.type === "api-key" ? selected.accessToken : `Bearer ${selected.accessToken}`,
          );
      const prior = store.credential.identity;
      if (checked.id !== prior.id || checked.workspace.id !== prior.workspace.id)
        fail("LINEAR_AUTH_IDENTITY_MISMATCH");
      const native = selected.mcp
        ? await this.nativeCapability(selected.accessToken, checked)
        : undefined;
      const latest = await this.read();
      if (latest?.epoch !== store.epoch) fail("LINEAR_AUTH_CONTEXT_CHANGED");
      if (selected.mcp && latest.credential?.native !== native) {
        return this.lock(async () => {
          const current = await this.read();
          if (
            current?.epoch !== store.epoch ||
            current.credential?.accessToken !== selected.accessToken
          )
            fail("LINEAR_AUTH_CONTEXT_CHANGED");
          const saved: Store = { ...current, credential: { ...current.credential, native } };
          await this.write(saved);
          return safeStatus(saved);
        });
      }
      return safeStatus(latest);
    }
    return safeStatus(store);
  }
  async epoch(): Promise<{ epoch: string; state: ConnectionStatus["state"] }> {
    const status = await this.status();
    return { epoch: status.epoch, state: status.state };
  }
  async isManaged(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }
  /** Native callers must not acquire an MCP-only token or fall back to another account. */
  async authorization(
    forceRefresh = false,
    target: "native" | "storage" = "native",
  ): Promise<string | undefined> {
    const selected = await this.selectedCredential(forceRefresh);
    if (!selected) return undefined;
    if (target === "storage" && selected.mcp) fail("LINEAR_AUTH_STORAGE_UNAVAILABLE");
    if (selected.native === false) fail("LINEAR_AUTH_NATIVE_UNAVAILABLE");
    return selected.type === "api-key" ? selected.accessToken : `Bearer ${selected.accessToken}`;
  }
  /** MCP dispatch may use an MCP-scoped grant, bound to the server it was issued for. */
  async bearerToken(forceRefresh = false, serverUrl?: string): Promise<string | undefined> {
    const selected = await this.selectedCredential(forceRefresh);
    if (selected?.mcp && serverUrl) assertMcpOAuthTarget(selected.mcp, serverUrl);
    return selected?.accessToken;
  }
  private async selectedCredential(forceRefresh = false): Promise<Credential | undefined> {
    let store = await this.read();
    this.pin(store?.epoch ?? "legacy");
    if (!store) return undefined;
    if (store.state !== "connected" || !store.credential) fail("LINEAR_AUTH_REQUIRED");
    const c = store.credential;
    if (
      c.type === "oauth" &&
      (forceRefresh || (c.expiresAt !== undefined && c.expiresAt <= Date.now() + 30_000))
    ) {
      store = await this.lock(async () => {
        const latest = await this.read();
        this.pin(latest?.epoch ?? "legacy");
        if (latest?.state !== "connected" || !latest.credential) fail("LINEAR_AUTH_REQUIRED");
        const current = latest.credential;
        if (
          current.accessToken !== c.accessToken &&
          (current.expiresAt === undefined || current.expiresAt > Date.now() + 30_000)
        )
          return latest;
        const renewal = current.appRenewal;
        if (renewal) {
          const provider = new LinearAppTokenProvider({ env: this.env });
          const request = await provider.renewalRequest(renewal);
          const payload = await this.exchange(
            request.body,
            this.env.LINEAR_AXI_TOKEN_URL ?? "https://api.linear.app/oauth/token",
          );
          const lifetime = payload.expires_in;
          if (typeof lifetime !== "number") fail("LINEAR_AUTH_INVALID_RESPONSE");
          const expiresAt = Date.now() + lifetime * 1000;
          if (
            typeof payload.token_type !== "string" ||
            payload.token_type.toLowerCase() !== "bearer" ||
            !Number.isFinite(lifetime) ||
            lifetime <= 30 ||
            !Number.isFinite(expiresAt) ||
            expiresAt > Number.MAX_SAFE_INTEGER
          )
            fail("LINEAR_AUTH_INVALID_RESPONSE");
          const accessToken = token(payload.access_token);
          const granted =
            payload.scope === undefined ? renewal.scopes : scopes(payload.scope, "app");
          if (
            granted.length !== renewal.scopes.length ||
            granted.some((scope) => !renewal.scopes.includes(scope))
          )
            fail("LINEAR_AUTH_INVALID_SCOPE");
          const { app, identity: who } = await this.verifyViewer(`Bearer ${accessToken}`);
          if (
            !app ||
            who.id !== current.identity.id ||
            who.workspace.id !== current.identity.workspace.id
          )
            fail("LINEAR_AUTH_IDENTITY_MISMATCH");
          if (expiresAt <= Date.now() + 30_000) fail("LINEAR_AUTH_INVALID_RESPONSE");
          const next: Credential = {
            ...current,
            accessToken,
            expiresAt,
            scopes: [...renewal.scopes],
            identity: who,
          };
          const saved: Store = { ...latest, credential: next };
          await this.write(saved);
          return saved;
        }
        if (!current.refreshToken || !current.clientId) fail("LINEAR_AUTH_EXPIRED");
        const payload = current.mcp
          ? await refreshMcpOAuth(current.mcp, current.refreshToken, this.fetchImpl)
          : await this.exchange(
              new URLSearchParams({
                grant_type: "refresh_token",
                client_id: current.clientId,
                refresh_token: current.refreshToken,
              }),
            );
        const next = this.credentials(payload, { ...current, type: "oauth" });
        const saved: Store = { ...latest, credential: next };
        await this.write(saved);
        return saved;
      });
    }
    if (!store.credential) fail("LINEAR_AUTH_REQUIRED");
    return store.credential;
  }
  async assertEpoch(): Promise<void> {
    this.pin((await this.read())?.epoch ?? "legacy");
  }
  private pin(epoch: string): void {
    if (this.boundEpoch !== undefined && this.boundEpoch !== epoch)
      fail("LINEAR_AUTH_CONTEXT_CHANGED");
    this.boundEpoch ??= epoch;
  }
  async logout(): Promise<ConnectionStatus> {
    return this.lock(async () => {
      const store: Store = { version: 1, epoch: randomUUID(), state: "signed-out" };
      await this.write(store);
      this.boundEpoch = undefined;
      return safeStatus(store);
    });
  }
  async importCredential(input: {
    type: CredentialType;
    token: string;
  }): Promise<ConnectionStatus> {
    if (!["api-key", "oauth"].includes(input.type)) fail("LINEAR_AUTH_INPUT_INVALID");
    const accessToken = token(input.token);
    const started = await this.reserve();
    const who = await this.verify(input.type === "api-key" ? accessToken : `Bearer ${accessToken}`);
    return this.commit(started.epoch, {
      type: input.type,
      accessToken,
      scopes: [],
      identity: who,
      ...(input.type === "api-key" ? { actor: "user" as const } : {}),
    });
  }
  /** Connect an already installed App without sending another OAuth authorization or token request. */
  async connectInstalledApp(): Promise<ConnectionStatus> {
    const cached = await new LinearAppTokenProvider({ env: this.env }).existingToken();
    const accessToken = token(cached.accessToken);
    const { app, identity: who } = await this.verifyViewer(`Bearer ${accessToken}`);
    if (!app) fail("LINEAR_AUTH_APP_REQUIRED");
    const started = await this.reserve();
    return this.commit(started.epoch, {
      type: "oauth",
      accessToken,
      expiresAt: cached.expiresAt,
      scopes: [],
      identity: who,
      actor: "app",
    });
  }
  /** Local-only opt-in: the operator declares the exact original client-credentials scopes. */
  async enableAppRenewal(declaredScopes: string[]): Promise<ConnectionStatus> {
    return this.lock(async () => {
      const store = await this.read();
      this.pin(store?.epoch ?? "legacy");
      const c = store?.credential;
      if (
        store?.state !== "connected" ||
        !c ||
        c.type !== "oauth" ||
        c.actor !== "app" ||
        c.mcp ||
        c.refreshToken ||
        c.clientId
      )
        fail("LINEAR_AUTH_APP_REQUIRED");
      const declared = appRenewalScopes(declaredScopes);
      const provider = new LinearAppTokenProvider({ env: this.env });
      const { binding } = await provider.renewalRequest(c.appRenewal);
      if (
        declared.length !== binding.scopes.length ||
        declared.some((scope) => !binding.scopes.includes(scope)) ||
        (c.scopes.length > 0 &&
          (c.scopes.length !== declared.length ||
            c.scopes.some((scope) => !declared.includes(scope))))
      )
        fail("LINEAR_AUTH_APP_RENEWAL_CONFIG");
      if (c.appRenewal) return safeStatus(store);
      if (!(await provider.matchesCachedToken(c.accessToken)))
        fail("LINEAR_AUTH_APP_TOKEN_UNAVAILABLE");
      const saved: Store = { ...store, credential: { ...c, appRenewal: binding } };
      await this.write(saved);
      return safeStatus(saved);
    });
  }
  async beginLogin(input: {
    actor: ConnectionActor;
    scopes?: string[];
    method?: "mcp" | "oauth";
  }): Promise<{ url: string; epoch: string; redirectUri: string }> {
    if (!["user", "app"].includes(input.actor)) fail("LINEAR_AUTH_INPUT_INVALID");
    const requested = scopes(input.scopes ?? ["read"], input.actor);
    if (!requested.includes("read")) requested.unshift("read");
    const config = await this.oauthConfig();
    if (input.method === "mcp") {
      if (input.actor !== "user") fail("LINEAR_AUTH_INPUT_INVALID");
      return this.beginMcpLogin(config.redirectUri, requested);
    }
    if (input.method === "oauth" && !config.clientId) fail("LINEAR_OAUTH_CLIENT_NOT_CONFIGURED");
    if (!config.clientId) {
      if (input.actor === "app") fail("LINEAR_OAUTH_CLIENT_NOT_CONFIGURED");
      return this.beginMcpLogin(config.redirectUri, requested);
    }
    const verifier = randomBytes(32).toString("base64url");
    const pending: PendingLogin = {
      state: randomBytes(32).toString("base64url"),
      verifier,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      actor: input.actor,
      scopes: requested,
      expiresAt: Date.now() + 10 * 60_000,
    };
    const started = await this.reserve(pending);
    const url = new URL(
      endpoint(this.env.LINEAR_AXI_OAUTH_AUTHORIZE_URL, "https://linear.app/oauth/authorize"),
    );
    for (const [key, value] of Object.entries({
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      response_type: "code",
      scope: requested.join(","),
      state: pending.state,
      actor: pending.actor,
      prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    return { url: url.href, epoch: started.epoch, redirectUri: pending.redirectUri };
  }
  private async beginMcpLogin(
    redirectUri: string,
    requested: string[],
  ): Promise<{ url: string; epoch: string; redirectUri: string }> {
    const started = await this.reserve();
    const state = randomBytes(32).toString("base64url");
    const result = await beginMcpOAuth({
      serverUrl: this.env.LINEAR_AXI_MCP_URL ?? "https://mcp.linear.app/mcp",
      redirectUri,
      state,
      scopes: requested,
      fetchImpl: this.fetchImpl,
    });
    return this.lock(async () => {
      if ((await this.read())?.epoch !== started.epoch) fail("LINEAR_AUTH_CONTEXT_CHANGED");
      const pending: PendingLogin = {
        state,
        verifier: result.verifier,
        clientId: result.session.client.client_id,
        redirectUri,
        actor: "user",
        scopes: requested,
        expiresAt: Date.now() + 10 * 60_000,
        mcp: result.session,
      };
      await this.write({ ...started, pending });
      return { url: result.url, epoch: started.epoch, redirectUri };
    });
  }
  async finishLogin(input: { callbackUrl: string }): Promise<ConnectionStatus> {
    const store = await this.read();
    const pending = store?.pending;
    if (!pending || store.state !== "signed-out") fail("LINEAR_AUTH_NO_PENDING_LOGIN");
    if (pending.expiresAt <= Date.now()) fail("LINEAR_AUTH_LOGIN_EXPIRED");
    let callback: URL;
    try {
      callback = new URL(input.callbackUrl);
    } catch {
      fail("LINEAR_AUTH_INPUT_INVALID");
    }
    const expected = new URL(pending.redirectUri);
    const actualState = callback.searchParams.get("state") ?? "";
    const given = Buffer.from(actualState);
    const wanted = Buffer.from(pending.state);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      (pending.mcp &&
        (callback.searchParams.has("iss") ||
          pending.mcp.metadata.authorization_response_iss_parameter_supported === true) &&
        callback.searchParams.get("iss") !== pending.mcp.issuer) ||
      given.length !== wanted.length ||
      !timingSafeEqual(given, wanted)
    )
      fail("LINEAR_AUTH_STATE_MISMATCH");
    if (callback.searchParams.has("error")) fail("LINEAR_AUTH_CONSENT_DENIED");
    const code = callback.searchParams.get("code");
    if (!code || code.length > 8192) fail("LINEAR_AUTH_INPUT_INVALID");
    // The lock prevents another process finishing/revoking/replacing this grant during exchange.
    return this.lock(async () => {
      const latest = await this.read();
      if (latest?.epoch !== store.epoch || latest.pending?.state !== pending.state)
        fail("LINEAR_AUTH_CONTEXT_CHANGED");
      const payload = pending.mcp
        ? await finishMcpOAuth(pending.mcp, {
            code,
            verifier: pending.verifier,
            redirectUri: pending.redirectUri,
            fetchImpl: this.fetchImpl,
          })
        : await this.exchange(
            new URLSearchParams({
              grant_type: "authorization_code",
              client_id: pending.clientId,
              redirect_uri: pending.redirectUri,
              code,
              code_verifier: pending.verifier,
            }),
          );
      const base = {
        type: "oauth" as const,
        accessToken: "",
        actor: pending.actor,
        scopes: pending.scopes,
        clientId: pending.clientId,
        ...(pending.mcp ? { mcp: pending.mcp } : {}),
        identity: {} as ConnectionIdentity,
      };
      const credential = this.credentials(payload, base);
      if (pending.mcp) {
        credential.identity = await mcpConnectionIdentity(
          pending.mcp,
          credential.accessToken,
          this.fetchImpl,
        );
        credential.native = await this.nativeCapability(
          credential.accessToken,
          credential.identity,
        );
      } else credential.identity = await this.verify(`Bearer ${credential.accessToken}`);
      const saved: Store = { version: 1, state: "connected", epoch: randomUUID(), credential };
      await this.write(saved);
      this.boundEpoch = undefined;
      return safeStatus(saved);
    });
  }
  async revoke(
    options: { forgetOnRefusal?: boolean; onRetired?: (epoch: string) => void } = {},
  ): Promise<ConnectionStatus> {
    const url = endpoint(
      this.env.LINEAR_AXI_OAUTH_REVOKE_URL,
      "https://api.linear.app/oauth/revoke",
    );
    const started = await this.lock(async () => {
      const store = await this.read();
      this.pin(store?.epoch ?? "legacy");
      if (
        store?.state !== "connected" ||
        store.credential?.type !== "oauth" ||
        store.credential.mcp
      )
        fail("LINEAR_AUTH_REVOKE_UNSUPPORTED");
      const credential = store.credential;
      const retiredEpoch = randomUUID();
      // Persist retirement before remote dispatch: process death cannot leave this grant active.
      await this.write({ version: 1, state: "signed-out", epoch: retiredEpoch });
      options.onRetired?.(retiredEpoch);
      this.boundEpoch = undefined;
      return { store, credential, retiredEpoch };
    });
    const body = new URLSearchParams({
      token: started.credential.refreshToken ?? started.credential.accessToken,
      token_type_hint: started.credential.refreshToken ? "refresh_token" : "access_token",
    });
    let result: Response;
    try {
      result = await this.fetchImpl(url, {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail("LINEAR_AUTH_REVOKE_UNKNOWN");
    }
    if (result.status >= 500 || result.status === 408) fail("LINEAR_AUTH_REVOKE_UNKNOWN");
    if (!result.ok) {
      if (!options.forgetOnRefusal)
        await this.lock(async () => {
          const current = await this.read();
          // A definite refusal may restore A, never overwrite a later login or logout.
          if (current?.epoch === started.retiredEpoch)
            await this.write({ ...started.store, epoch: randomUUID() });
        });
      fail("LINEAR_AUTH_REVOKE_REFUSED");
    }
    return this.status();
  }
  /** Keep the retired grant locked while the catalog forgets it. */
  async withRetired(epoch: string, operation: () => Promise<void>): Promise<boolean> {
    return this.lock(async () => {
      const current = await this.read();
      if (current?.state !== "signed-out" || current.epoch !== epoch) return false;
      await operation();
      return true;
    });
  }
  async cancelLogin(epoch: string): Promise<void> {
    await this.lock(async () => {
      const current = await this.read();
      if (current?.epoch === epoch && current.pending)
        await this.write({ version: 1, state: "signed-out", epoch: randomUUID() });
    });
  }

  private async reserve(pending?: PendingLogin): Promise<Store> {
    return this.lock(async () => {
      const previous = await this.read();
      if (previous?.state === "connected") fail("LINEAR_AUTH_LOGOUT_REQUIRED");
      const started: Store = {
        version: 1,
        state: "signed-out",
        epoch: randomUUID(),
        ...(pending ? { pending } : {}),
      };
      await this.write(started);
      this.boundEpoch = undefined;
      return started;
    });
  }
  private async commit(epoch: string, credential: Credential): Promise<ConnectionStatus> {
    return this.lock(async () => {
      if ((await this.read())?.epoch !== epoch) fail("LINEAR_AUTH_CONTEXT_CHANGED");
      const store: Store = { version: 1, epoch: randomUUID(), state: "connected", credential };
      await this.write(store);
      this.boundEpoch = undefined;
      return safeStatus(store);
    });
  }
  private credentials(payload: InputRecord, prior: Credential): Credential {
    const accessToken = token(payload.access_token);
    const lifetime = payload.expires_in;
    if (
      lifetime !== undefined &&
      (typeof lifetime !== "number" || !Number.isFinite(lifetime) || lifetime < 0)
    )
      fail("LINEAR_AUTH_INVALID_RESPONSE");
    const granted = payload.scope !== undefined ? scopes(payload.scope, prior.actor) : prior.scopes;
    if (granted.some((scope) => !prior.scopes.includes(scope))) fail("LINEAR_AUTH_SCOPE_MISMATCH");
    return {
      ...prior,
      accessToken,
      ...(payload.refresh_token ? { refreshToken: token(payload.refresh_token) } : {}),
      ...(typeof lifetime === "number"
        ? { expiresAt: Date.now() + lifetime * 1000 }
        : { expiresAt: undefined }),
      scopes: granted,
    };
  }
  private async exchange(
    body: URLSearchParams,
    tokenUrl = this.env.LINEAR_AXI_OAUTH_TOKEN_URL ?? this.env.LINEAR_AXI_TOKEN_URL,
  ): Promise<InputRecord> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint(tokenUrl, "https://api.linear.app/oauth/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail("LINEAR_AUTH_EXCHANGE_FAILED");
    }
    if (!response.ok) fail("LINEAR_AUTH_EXCHANGE_FAILED");
    try {
      return record(await response.json());
    } catch {
      fail("LINEAR_AUTH_INVALID_RESPONSE");
    }
  }
  private async nativeCapability(
    accessToken: string,
    expected: ConnectionIdentity,
  ): Promise<boolean> {
    let checked: ConnectionIdentity;
    try {
      checked = await this.verify(`Bearer ${accessToken}`);
    } catch {
      return false;
    }
    if (checked.id !== expected.id || checked.workspace.id !== expected.workspace.id)
      fail("LINEAR_AUTH_IDENTITY_MISMATCH");
    return true;
  }
  private async verify(authorization: string): Promise<ConnectionIdentity> {
    return (await this.verifyViewer(authorization)).identity;
  }
  private async verifyViewer(
    authorization: string,
  ): Promise<{ identity: ConnectionIdentity; app: boolean }> {
    const url = endpoint(this.env.LINEAR_AXI_GRAPHQL_URL, "https://api.linear.app/graphql");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          query:
            "query ConnectionIdentity { viewer { id name email app organization { id name urlKey } } }",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const reason = resourceOperationFailure("OPERATION", error).reason;
      if (reason === "TIMEOUT") fail("LINEAR_AUTH_IDENTITY_TIMEOUT");
      if (reason === "CONNECTION_FAILED") fail("LINEAR_AUTH_IDENTITY_CONNECTION_FAILED");
      fail("LINEAR_AUTH_IDENTITY_UNAVAILABLE");
    }
    if (!response.ok) fail("LINEAR_AUTH_INVALID_CREDENTIAL");
    try {
      const payload = record(await response.json());
      if (payload.errors != null && (!isUnknownArray(payload.errors) || payload.errors.length > 0))
        fail("LINEAR_AUTH_INVALID_CREDENTIAL");
      const viewer = record(record(payload.data).viewer);
      return { identity: identity(viewer), app: viewer.app === true };
    } catch {
      fail("LINEAR_AUTH_INVALID_CREDENTIAL");
    }
  }
  private async oauthConfig(): Promise<{ clientId?: string; redirectUri: string }> {
    let config: InputRecord = {};
    if (!this.env.LINEAR_AXI_OAUTH_CLIENT_ID) {
      const path =
        this.env.LINEAR_AXI_OAUTH_CONFIG_FILE ??
        join(
          this.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
          "config",
          "linear-axi",
          "oauth-client.json",
        );
      await safePath(resolve(path));
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 16384) fail("LINEAR_AUTH_CONFIG_INVALID");
          config = record(JSON.parse(await file.readFile("utf8")));
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("LINEAR_AUTH_CONFIG_INVALID");
      }
    }
    const clientId = this.env.LINEAR_AXI_OAUTH_CLIENT_ID ?? config.clientId;
    if (
      clientId !== undefined &&
      (typeof clientId !== "string" || !clientId.trim() || clientId.length > 1024)
    )
      fail("LINEAR_AUTH_CONFIG_INVALID");
    let redirect: URL;
    try {
      const configured =
        this.env.LINEAR_AXI_OAUTH_REDIRECT_URI ??
        config.redirectUri ??
        "http://127.0.0.1:14566/oauth/callback";
      if (typeof configured !== "string") fail("LINEAR_AUTH_CONFIG_INVALID");
      redirect = new URL(configured);
    } catch {
      fail("LINEAR_AUTH_CONFIG_INVALID");
    }
    if (
      redirect.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    )
      fail("LINEAR_AUTH_CONFIG_INVALID");
    return { clientId, redirectUri: redirect.href };
  }
  protected async readJson(path = this.path): Promise<unknown> {
    await safePath(path);
    let file: FileHandle;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail("LINEAR_AUTH_STORE_UNSAFE");
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > MAX_CONNECTION_STORE_BYTES ||
        (process.platform !== "win32" && info.mode & 0o077)
      )
        fail("LINEAR_AUTH_STORE_UNSAFE");
      await windowsPrivate(path);
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      return value;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("LINEAR_AUTH_STORE_")) throw error;
      fail("LINEAR_AUTH_STORE_INVALID");
    } finally {
      await file.close();
    }
  }
  private async read(): Promise<Store | undefined> {
    const raw = await this.readJson();
    if (raw === undefined) return undefined;
    try {
      const value = record(raw);
      if (
        value.version !== 1 ||
        typeof value.epoch !== "string" ||
        !value.epoch ||
        (value.state !== "signed-out" && value.state !== "connected")
      )
        fail("LINEAR_AUTH_STORE_INVALID");
      if (value.state === "connected") {
        const c = record(value.credential);
        if (c.type !== "api-key" && c.type !== "oauth") fail("LINEAR_AUTH_STORE_INVALID");
        token(c.accessToken);
        if (c.native !== undefined && typeof c.native !== "boolean")
          fail("LINEAR_AUTH_STORE_INVALID");
        if (c.mcp !== undefined) {
          if (c.type !== "oauth" || c.actor !== "user" || typeof c.native !== "boolean")
            fail("LINEAR_AUTH_STORE_INVALID");
          validateMcpOAuthSession(c.mcp);
        }
        if (c.refreshToken !== undefined) token(c.refreshToken);
        const actor = c.actor;
        if (actor !== undefined && actor !== "user" && actor !== "app")
          fail("LINEAR_AUTH_STORE_INVALID");
        if (!isUnknownArray(c.scopes)) fail("LINEAR_AUTH_STORE_INVALID");
        const granted = scopes(c.scopes, actor);
        if (c.appRenewal !== undefined) {
          const binding = record(c.appRenewal);
          text(binding.clientId);
          const boundScopes = appRenewalScopes(binding.scopes);
          if (
            c.type !== "oauth" ||
            c.actor !== "app" ||
            c.mcp ||
            c.refreshToken ||
            c.clientId ||
            !Number.isFinite(c.expiresAt) ||
            (granted.length > 0 &&
              (granted.length !== boundScopes.length ||
                granted.some((scope) => !boundScopes.includes(scope))))
          )
            fail("LINEAR_AUTH_STORE_INVALID");
        }
        if (c.expiresAt !== undefined && !Number.isFinite(c.expiresAt))
          fail("LINEAR_AUTH_STORE_INVALID");
        const who = record(c.identity);
        const workspace = record(who.workspace);
        for (const v of [who.id, who.name, workspace.id, workspace.slug, workspace.name]) text(v);
      }
      if (value.pending !== undefined) {
        const pending = record(value.pending);
        for (const v of [pending.state, pending.verifier, pending.clientId, pending.redirectUri])
          text(v);
        if (
          value.state !== "signed-out" ||
          (pending.actor !== "user" && pending.actor !== "app") ||
          !Number.isFinite(pending.expiresAt)
        )
          fail("LINEAR_AUTH_STORE_INVALID");
        scopes(pending.scopes, pending.actor);
        if (pending.mcp !== undefined) {
          if (pending.actor !== "user") fail("LINEAR_AUTH_STORE_INVALID");
          validateMcpOAuthSession(pending.mcp);
        }
      }
      return raw as Store;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("LINEAR_AUTH_STORE_")) throw error;
      fail("LINEAR_AUTH_STORE_INVALID");
    }
  }
  protected async write(value: unknown, path = this.path): Promise<void> {
    await safePath(path);
    await windowsPrivate(dirname(path));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await windowsPrivate(temporary);
        await file.writeFile(JSON.stringify(value) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await safePath(path);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  protected async lock<T>(operation: () => Promise<T>): Promise<T> {
    await safePath(this.path);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await safePath(this.path);
    await windowsPrivate(dirname(this.path));
    const path = `${this.path}.lock`;
    const until = Date.now() + 5000;
    let lock: FileHandle | undefined;
    while (!lock) {
      try {
        lock = await open(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("LINEAR_AUTH_STORE_UNSAFE");
        if (Date.now() >= until) fail("LINEAR_AUTH_BUSY");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    // execFile cancellation sends SIGTERM. Release our lock before the CLI exits so a
    // cancelled code exchange/refresh cannot leave every later auth command busy.
    const cleanup = () => {
      try {
        unlinkSync(path);
      } catch {
        /* The finally path may already have removed it. */
      }
    };
    const terminate = () => {
      process.exitCode = 143;
      process.exit();
    };
    process.once("exit", cleanup);
    process.once("SIGTERM", terminate);
    try {
      return await operation();
    } finally {
      process.removeListener("exit", cleanup);
      process.removeListener("SIGTERM", terminate);
      await lock.close();
      await rm(path, { force: true });
    }
  }
}
