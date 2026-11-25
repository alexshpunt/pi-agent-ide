import { createPrivateKey, createSign } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  type GithubRequestCoordinator,
  githubRequestCoordinator,
  GithubNotSentError,
} from "./request-coordinator.ts";
import {
  GithubRateLimitError,
  isGithubRateLimitResponse,
  rateLimitInfoFromHeaders,
} from "./rate-limit.ts";
import { assertWindowsPrivateFile } from "./windows-private-path.ts";

interface AppAuthOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  coordinator?: GithubRequestCoordinator;
}

/** Existing App settings. Keep the PEM file outside repositories. */
export interface AppConfig {
  appId: number;
  installationId: number;
  privateKeyPath: string;
}

/** The actual App bot account, verified through GitHub. */
export interface BotIdentity {
  login: string;
  name: string;
  email: string;
}

/** Internal short-lived credentials. Never print or persist this value. */
export interface InstallationToken {
  token: string;
  expiresAt: number;
}

/** Outcome of revoking one already-issued installation token, not the App installation. */
export type InstallationTokenRevocation =
  | "not-cached"
  | "not-sent"
  | "revoked"
  | "refused"
  | "unknown";

/** Validate App settings without accepting embedded credentials or echoing values. */
export function parseAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub App configuration needs App/installation IDs and a private key path.");
  }
  const config = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(config.appId) ||
    Number(config.appId) <= 0 ||
    !Number.isSafeInteger(config.installationId) ||
    Number(config.installationId) <= 0 ||
    typeof config.privateKeyPath !== "string" ||
    !path.isAbsolute(config.privateKeyPath) ||
    Object.keys(config).some((key) => !["appId", "installationId", "privateKeyPath"].includes(key))
  ) {
    throw new Error(
      "GitHub App configuration needs positive IDs and an absolute private key path, not credentials.",
    );
  }
  return {
    appId: Number(config.appId),
    installationId: Number(config.installationId),
    privateKeyPath: config.privateKeyPath,
  };
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("GitHub authorization was cancelled.");
}

/** Cancel this caller's wait without cancelling work shared by other callers. */
function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  // Creating pending may already have synchronously aborted its signal.
  void pending.catch(() => {});
  check(signal);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("GitHub authorization was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Signs App JWTs and keeps renewable installation credentials in memory only.
 * Cancellation stops the caller's wait; concurrent callers share refresh work.
 * clear() also aborts shared requests and prevents old work from restoring state.
 */
export class GithubAppAuth {
  #config: AppConfig;
  #fetch: typeof fetch;
  readonly #coordinator: GithubRequestCoordinator;
  #now: () => number;
  #identity?: BotIdentity;
  #token?: InstallationToken;
  #refresh?: Promise<InstallationToken>;
  #initializing?: Promise<void>;
  #revoking = false;
  #lifetime = new AbortController();

  constructor(config: AppConfig, options: AppAuthOptions = {}) {
    this.#config = parseAppConfig(config);
    this.#coordinator = options.coordinator ?? githubRequestCoordinator;
    this.#fetch = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  get quotaOwner(): string {
    return `installation:${this.#config.appId}:${this.#config.installationId}`;
  }
  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }
  /** Read the verified identity. Throws until initialization succeeds. */
  get identity(): BotIdentity {
    if (!this.#identity) throw new Error("GitHub bot identity is not ready.");
    return { ...this.#identity };
  }

  /** Verify the current App and bot. Concurrent initialization is shared. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.#revoking) throw new Error("GH_AUTH_REVOKING");
    check(signal);
    if (this.#identity) return;
    if (!this.#initializing) {
      const lifetime = this.#lifetime.signal;
      const initializing = this.#initialize(lifetime).finally(() => {
        if (this.#initializing === initializing) this.#initializing = undefined;
      });
      this.#initializing = initializing;
    }
    await waitFor(this.#initializing, signal);
  }

  /** Refresh two minutes early. A cancelled waiter does not poison other requests. */
  async getToken(signal?: AbortSignal): Promise<InstallationToken> {
    if (this.#revoking) throw new Error("GH_AUTH_REVOKING");
    check(signal);
    if (this.#token && this.#token.expiresAt > this.#now() + 120_000) return { ...this.#token };
    if (!this.#refresh) {
      const lifetime = this.#lifetime.signal;
      const refresh = this.#mint(lifetime).finally(() => {
        if (this.#refresh === refresh) this.#refresh = undefined;
      });
      this.#refresh = refresh;
    }
    return { ...(await waitFor(this.#refresh, signal)) };
  }

  /** Revoke only this instance's cached token. Never mint or retry a token for logout. */
  async revokeCachedToken(signal?: AbortSignal): Promise<InstallationTokenRevocation> {
    if (this.#revoking || signal?.aborted) return "not-sent";
    const token = this.#token?.token;
    // Retire the old lifetime before the request so an in-flight refresh cannot restore it.
    this.clear();
    if (!token) return "not-cached";
    this.#revoking = true;
    const lifetime = this.#lifetime.signal;
    const requestSignal = AbortSignal.any([
      lifetime,
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const response = await this.#coordinator.fetch(
        this.quotaOwner,
        "https://api.github.com/installation/token",
        {
          method: "DELETE",
          redirect: "error",
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        { fetcher: this.#fetch },
      );
      void response.body?.cancel().catch(() => {});
      if (response.status === 204) return "revoked";
      if (response.status >= 400 && response.status < 500 && response.status !== 408)
        return "refused";
      return "unknown";
    } catch (error) {
      return error instanceof GithubNotSentError || error instanceof GithubRateLimitError
        ? "not-sent"
        : "unknown";
    } finally {
      this.#revoking = false;
    }
  }
  /** Drop all credentials and identity, and cancel requests owned by this instance. */
  clear(): void {
    this.#lifetime.abort();
    this.#lifetime = new AbortController();
    this.#token = undefined;
    this.#identity = undefined;
    this.#refresh = undefined;
    this.#initializing = undefined;
  }

  async #initialize(signal: AbortSignal): Promise<void> {
    const app = await this.#request("/app", await this.#jwt(signal), signal);
    if (!app || typeof app !== "object" || Array.isArray(app))
      throw new Error("GitHub App identity did not match its configuration.");
    const details = app as Record<string, unknown>;
    if (
      details.id !== this.#config.appId ||
      typeof details.slug !== "string" ||
      !/^[a-z0-9-]+$/.test(details.slug)
    ) {
      throw new Error("GitHub App identity did not match its configuration.");
    }
    const login = details.slug + "[bot]";
    const credential = await this.getToken(signal);
    const bot = await this.#request(
      "/users/" + encodeURIComponent(login),
      credential.token,
      signal,
    );
    if (!bot || typeof bot !== "object" || Array.isArray(bot))
      throw new Error("GitHub could not verify the App bot account.");
    const account = bot as Record<string, unknown>;
    if (account.login !== login || !Number.isSafeInteger(account.id) || Number(account.id) <= 0) {
      throw new Error("GitHub could not verify the App bot account.");
    }
    check(signal);
    this.#identity = {
      login,
      name: login,
      email: account.id + "+" + login + "@users.noreply.github.com",
    };
  }

  async #mint(signal: AbortSignal): Promise<InstallationToken> {
    const data = await this.#request(
      "/app/installations/" + this.#config.installationId + "/access_tokens",
      await this.#jwt(signal),
      signal,
      "POST",
    );
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("GitHub returned an invalid installation credential.");
    const credential = data as Record<string, unknown>;
    const expiresAt =
      typeof credential.expires_at === "string" ? Date.parse(credential.expires_at) : NaN;
    if (
      typeof credential.token !== "string" ||
      !credential.token ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.#now() + 120_000
    )
      throw new Error("GitHub returned an invalid installation credential.");
    check(signal);
    this.#token = { token: credential.token, expiresAt };
    return this.#token;
  }

  async #jwt(signal: AbortSignal): Promise<string> {
    return signAppJwt(this.#config, this.#now, signal);
  }

  async #request(
    route: string,
    credential: string,
    lifetime: AbortSignal,
    method = "GET",
  ): Promise<unknown> {
    const owner =
      route === "/app" || route.startsWith("/app/") ? `app:${this.#config.appId}` : this.quotaOwner;
    return requestAppJson(
      this.#fetch,
      route,
      credential,
      lifetime,
      method,
      this.#coordinator,
      owner,
    );
  }
}

function isRegistrationConfig(config: unknown): config is AppRegistrationConfig {
  if (
    !config ||
    typeof config !== "object" ||
    !("appId" in config) ||
    !("privateKeyPath" in config)
  )
    return false;
  return (
    typeof config.appId === "number" &&
    Number.isSafeInteger(config.appId) &&
    config.appId > 0 &&
    typeof config.privateKeyPath === "string" &&
    path.isAbsolute(config.privateKeyPath) &&
    Object.keys(config).every((key) => key === "appId" || key === "privateKeyPath")
  );
}

/** An App key can discover installations before any installation token exists. */
export type AppRegistrationConfig = Pick<AppConfig, "appId" | "privateKeyPath">;
export interface GithubInstallationChoice {
  readonly id: number;
  readonly account: string;
  readonly repositories: "all" | "selected";
  readonly suspended: boolean;
}
export class GithubAppRegistration {
  readonly #config: AppRegistrationConfig;
  readonly #fetch: typeof fetch;
  readonly #coordinator: GithubRequestCoordinator;
  readonly #now: () => number;
  constructor(config: AppRegistrationConfig, options: AppAuthOptions = {}) {
    if (!isRegistrationConfig(config))
      throw new Error(
        "GitHub App registration needs a positive App ID and an absolute private key path.",
      );
    this.#config = { ...config };
    this.#fetch = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#coordinator = options.coordinator ?? githubRequestCoordinator;
  }
  async listInstallations(
    page = 1,
    signal?: AbortSignal,
  ): Promise<{ installations: GithubInstallationChoice[]; hasMore: boolean }> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
      throw new Error("Invalid installation page.");
    const lifetime = signal ?? new AbortController().signal;
    const data = await requestAppJson(
      this.#fetch,
      `/app/installations?per_page=20&page=${page}`,
      await signAppJwt(this.#config, this.#now, lifetime),
      lifetime,
      "GET",
      this.#coordinator,
      `app:${this.#config.appId}`,
    );
    if (!Array.isArray(data) || data.length > 20)
      throw new Error("GitHub returned invalid installation metadata.");
    const installations = data.map((value): GithubInstallationChoice => {
      const item = value as Record<string, unknown> | null;
      const account = item?.account as Record<string, unknown> | null;
      if (
        !item ||
        !Number.isSafeInteger(item.id) ||
        Number(item.id) <= 0 ||
        !account ||
        typeof account.login !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(account.login) ||
        !["all", "selected"].includes(String(item.repository_selection)) ||
        !(item.suspended_at === null || typeof item.suspended_at === "string")
      )
        throw new Error("GitHub returned invalid installation metadata.");
      return {
        id: Number(item.id),
        account: account.login,
        repositories: item.repository_selection as "all" | "selected",
        suspended: item.suspended_at !== null,
      };
    });
    return { installations, hasMore: data.length === 20 };
  }
}

async function signAppJwt(
  config: AppRegistrationConfig,
  clock: () => number,
  signal: AbortSignal,
): Promise<string> {
  check(signal);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  try {
    file = await open(
      config.privateKeyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 65_536 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("unsafe key");
    await assertWindowsPrivateFile(config.privateKeyPath, stat);
    bytes = Buffer.alloc(65_537);
    let size = 0;
    for (;;) {
      check(signal);
      const part = await file.read(bytes, size, bytes.length - size, null);
      size += part.bytesRead;
      if (size > 65_536) throw new Error("key too large");
      if (part.bytesRead === 0) break;
    }
    const key = createPrivateKey(bytes.subarray(0, size));
    if (key.asymmetricKeyType !== "rsa") throw new Error("App JWTs require an RSA key");
    check(signal);
    const now = Math.floor(clock() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(config.appId) }),
    ).toString("base64url");
    const unsigned = header + "." + claims;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    return unsigned + "." + signer.sign(key, "base64url");
  } catch {
    check(signal);
    throw new Error(
      process.platform === "win32"
        ? "GitHub App private key must be a valid private regular PEM file with restricted Windows permissions, not a link."
        : "GitHub App private key must be a valid owner-only regular PEM file (chmod 600), not a symlink.",
    );
  } finally {
    bytes?.fill(0);
    await file?.close();
  }
}

async function requestAppJson(
  fetcher: typeof fetch,
  route: string,
  credential: string,
  lifetime: AbortSignal,
  method: string,
  coordinator: GithubRequestCoordinator,
  owner: string,
): Promise<unknown> {
  check(lifetime);
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(15_000)]);
  const url = "https://api.github.com" + route;
  let response: Response;
  try {
    response = await waitFor(
      coordinator.fetch(
        owner,
        url,
        {
          method,
          redirect: "error",
          headers: {
            Authorization: "Bearer " + credential,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
          },
          signal,
        },
        { fetcher },
      ),
      signal,
    );
    check(signal);
  } catch (error) {
    if (error instanceof GithubRateLimitError || error instanceof GithubNotSentError) throw error;
    check(lifetime);
    // oxlint-disable-next-line eslint/preserve-caught-error -- transport errors can carry credentials; never retain them as causes
    throw new Error("GitHub authorization request failed. No personal credential was used.");
  }
  if (isGithubRateLimitResponse(response.status, response.headers)) {
    void response.body?.cancel().catch(() => {});
    throw new GithubRateLimitError(rateLimitInfoFromHeaders(response.headers, undefined, true));
  }
  if (!response.ok && response.status !== 403) {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      "GitHub authorization API " + response.status + ". No personal credential was used.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an unreadable authorization response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let data: unknown;
  try {
    for (;;) {
      const part = await waitFor(reader.read(), signal);
      check(signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) throw new Error("response too large");
      chunks.push(part.value);
    }
    data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    void reader.cancel().catch(() => {});
    check(lifetime);
    if (!response.ok)
      throw new Error(
        "GitHub authorization API " + response.status + ". No personal credential was used.",
      );
    throw new Error("GitHub returned an unreadable authorization response.");
  } finally {
    reader.releaseLock();
  }
  if (isGithubRateLimitResponse(response.status, response.headers, data)) {
    await coordinator.observe(owner, url, response, data);
    throw new GithubRateLimitError(rateLimitInfoFromHeaders(response.headers, undefined, true));
  }
  if (!response.ok)
    throw new Error(
      "GitHub authorization API " + response.status + ". No personal credential was used.",
    );
  return data;
}
