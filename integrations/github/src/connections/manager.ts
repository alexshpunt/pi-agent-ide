import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { GithubAppAuth, type AppConfig, type InstallationTokenRevocation } from "#github/auth.ts";
import { GithubClient, type GithubCredentials } from "#github/client.ts";
import { loadGithubConfig } from "#github/config.ts";
import { GithubConnectionStore } from "./store.ts";
import { GithubRequestCoordinator, githubRequestCoordinator } from "#github/request-coordinator.ts";
import { refreshUserToken, verifyUser } from "./oauth.ts";
import type { GithubConnectionStorage, GithubProfile } from "./types.ts";

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("GH_CANCELLED");
}
function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  void pending.catch(() => {});
  check(signal);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("GH_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A captured connection is an operation boundary, not a mutable global token. */
export interface GithubConnectionAccess {
  readonly profile: GithubProfile;
  readonly key: string;
  readonly owner: string;
  readonly client: GithubClient;
  readonly credentials: GithubCredentials;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface GithubConnectionBoundary {
  capture(cwd: string, signal?: AbortSignal): Promise<GithubConnectionAccess>;
  onChange(listener: () => void): () => void;
}
interface Options {
  readonly coordinator?: GithubRequestCoordinator;
  readonly store?: GithubConnectionStorage;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly legacyConfig?: (cwd: string) => Promise<AppConfig | undefined>;
}
interface Active {
  readonly access: GithubConnectionAccess;
  readonly fingerprint: string;
  readonly lifetime: AbortController;
  readonly clear: () => void;
  readonly revokeCachedToken?: (signal?: AbortSignal) => Promise<InstallationTokenRevocation>;
}

/** Personal credentials are read under the same lock used for rotating refresh tokens. */
class UserCredentials implements GithubCredentials {
  readonly #profile: Exclude<GithubProfile, { kind: "app" }>;
  readonly #store: GithubConnectionStorage;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #lifetime = new AbortController();
  #identity?: GithubCredentials["identity"];
  #verifiedToken?: string;
  #initializing?: Promise<void>;

  constructor(
    profile: Exclude<GithubProfile, { kind: "app" }>,
    store: GithubConnectionStorage,
    fetcher: typeof fetch,
    now: () => number,
    readonly coordinator: GithubRequestCoordinator,
  ) {
    this.#profile = profile;
    this.#store = store;
    this.#fetch = fetcher;
    this.#now = now;
  }
  get quotaOwner(): string | undefined {
    const login = this.#identity?.login ?? this.#profile.login;
    return login ? `user:${login.toLowerCase()}` : undefined;
  }
  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }
  get identity() {
    if (!this.#identity) throw new Error("GH_IDENTITY_UNVERIFIED");
    return { ...this.#identity };
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    check(signal);
    check(this.#lifetime.signal);
    if (this.#identity) return;
    if (!this.#initializing) {
      const pending = (async () => {
        const token = await this.getToken(this.#lifetime.signal);
        const identity = await verifyUser(token.token, {
          fetcher: this.#fetch,
          coordinator: this.coordinator,
          quotaOwner: this.quotaOwner,
          signal: this.#lifetime.signal,
        });
        check(this.#lifetime.signal);
        this.#identity = identity;
        this.#verifiedToken = token.token;
      })();
      this.#initializing = pending;
      void pending
        .finally(() => {
          if (this.#initializing === pending) this.#initializing = undefined;
        })
        .catch(() => {});
    }
    await waitFor(this.#initializing, signal);
  }
  async getToken(signal?: AbortSignal): Promise<{ token: string; expiresAt: number }> {
    check(signal);
    check(this.#lifetime.signal);
    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    return this.#store.withSecret(
      this.#profile.id,
      async (current) => {
        check(combined);
        if (!current || current.kind !== this.#profile.kind)
          throw new Error("GH_CONNECTION_CREDENTIALS_MISSING");
        let secret = current;
        if (
          secret.kind === "device" &&
          secret.expiresAt !== undefined &&
          secret.expiresAt <= this.#now() + 120_000
        ) {
          if (this.#profile.kind !== "device") throw new Error("GH_CONNECTION_CHANGED");
          secret = await refreshUserToken(this.#profile.clientId, secret, {
            fetcher: this.#fetch,
            coordinator: this.coordinator,
            quotaOwner: this.quotaOwner,
            now: this.#now,
            signal: combined,
          });
        }
        const token = secret.kind === "pat" ? secret.token : secret.accessToken;
        if (this.#identity && token !== this.#verifiedToken) {
          const identity = await verifyUser(token, {
            fetcher: this.#fetch,
            coordinator: this.coordinator,
            quotaOwner: this.quotaOwner,
            signal: combined,
          });
          if (identity.login !== this.#identity.login) throw new Error("GH_IDENTITY_CHANGED");
          this.#identity = identity;
          this.#verifiedToken = token;
        }
        check(combined);
        return {
          secret,
          value: {
            token,
            expiresAt:
              secret.kind === "device"
                ? (secret.expiresAt ?? Number.MAX_SAFE_INTEGER)
                : Number.MAX_SAFE_INTEGER,
          },
        };
      },
      combined,
    );
  }
  clear(): void {
    this.#lifetime.abort();
    this.#identity = undefined;
    this.#verifiedToken = undefined;
  }
}

/** One Pi session owns its selection. Project defaults are pinned, never watched globals. */
export class GithubConnections implements GithubConnectionBoundary {
  readonly store: GithubConnectionStorage;
  readonly coordinator: GithubRequestCoordinator;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #legacy: (cwd: string) => Promise<AppConfig | undefined>;
  readonly #instance = randomUUID();
  readonly #defaults = new Map<string, Promise<string | undefined>>();
  #globalDefault?: Promise<{ id: string | undefined; preferred: boolean }>;
  readonly #listeners = new Set<() => void>();
  #override?: string;
  #epoch = 0;
  #project?: string;
  #active?: Active;
  #pending?: { project: string; epoch: number; value: Promise<GithubConnectionAccess> };
  #disposed = false;

  constructor(options: Options = {}) {
    const directory = process.env.PI_GITHUB_CONFIG_DIR;
    if (directory !== undefined && (!directory.trim() || !path.isAbsolute(directory)))
      throw new Error("GH_INVALID_CONFIG_DIRECTORY");
    this.store = options.store ?? new GithubConnectionStore(directory);
    this.coordinator =
      options.coordinator ??
      (this.store instanceof GithubConnectionStore
        ? new GithubRequestCoordinator({
            directory: path.join(this.store.directory, "rate-limits"),
          })
        : githubRequestCoordinator);
    this.#fetch = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#legacy =
      options.legacyConfig ??
      (async (cwd) => {
        try {
          return await loadGithubConfig(cwd);
        } catch {
          return undefined;
        }
      });
  }
  get sessionProfile(): string | undefined {
    return this.#override;
  }
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  /** The caller persists only this non-secret profile reference in its own session. */
  useProfile(id: string | undefined): void {
    if (this.#disposed) throw new Error("GH_SESSION_CLOSED");
    this.#override = id;
    if (id === undefined) {
      this.#defaults.clear();
      this.#globalDefault = undefined;
    }
    this.#retire();
  }
  invalidate(profileId?: string): void {
    if (profileId === undefined || !this.#active || this.#active.access.profile.id === profileId)
      this.#retire();
  }
  /** Only revoke an existing token held by this session; never create an App credential for logout. */
  async revokeCachedInstallationToken(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<InstallationTokenRevocation> {
    const active = this.#active;
    if (!active || active.access.profile.id !== profileId || !active.revokeCachedToken)
      return "not-cached";
    return active.revokeCachedToken(signal);
  }
  dispose(): void {
    this.#disposed = true;
    this.#retire();
    this.#listeners.clear();
  }

  async capture(cwd: string, signal?: AbortSignal): Promise<GithubConnectionAccess> {
    check(signal);
    if (this.#disposed) throw new Error("GH_SESSION_CLOSED");
    const project = path.resolve(cwd);
    if (this.#project !== undefined && this.#project !== project) this.#retire();
    this.#project = project;
    const epoch = this.#epoch;
    if (!this.#pending || this.#pending.project !== project || this.#pending.epoch !== epoch) {
      const value = this.#activate(project, epoch);
      const pending = { project, epoch, value };
      this.#pending = pending;
      void value
        .finally(() => {
          if (this.#pending === pending) this.#pending = undefined;
        })
        .catch(() => {});
    }
    return waitFor(this.#pending.value, signal);
  }
  async clientFor(cwd: string): Promise<GithubClient> {
    return (await this.capture(cwd)).client;
  }
  async credentialsFor(cwd: string): Promise<GithubCredentials> {
    return (await this.capture(cwd)).credentials;
  }

  #retire(): void {
    this.#epoch++;
    const old = this.#active;
    this.#active = undefined;
    this.#pending = undefined;
    old?.lifetime.abort();
    old?.clear();
    for (const listener of this.#listeners) listener();
  }
  #assert(epoch: number): void {
    if (this.#disposed || epoch !== this.#epoch) throw new Error("GH_CONNECTION_CHANGED");
  }
  async #default(project: string): Promise<string | undefined> {
    let pending = this.#defaults.get(project);
    if (!pending) {
      this.#globalDefault ??= this.store.getGlobalDefaultChoice();
      const globalChoice = this.#globalDefault;
      pending = (async () => {
        const globalDefault = await globalChoice;
        if (globalDefault.preferred) return globalDefault.id;
        const projectDefault = await this.store.ensureLegacyDefault(project, async () => {
          const config = await this.#legacy(project);
          if (!config) return undefined;
          const id =
            "legacy-" +
            createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 20);
          return { id, label: "Existing GitHub App", kind: "app", ...config };
        });
        return projectDefault ?? globalDefault.id;
      })();
      this.#defaults.set(project, pending);
    }
    return pending;
  }
  async #activate(project: string, initialEpoch: number): Promise<GithubConnectionAccess> {
    const id = this.#override ?? (await this.#default(project));
    this.#assert(initialEpoch);
    if (!id) throw new Error("GH_CONNECTION_REQUIRED");
    const profile = await this.store.getProfile(id);
    this.#assert(initialEpoch);
    if (!profile) throw new Error("GH_CONNECTION_MISSING");
    const fingerprint = JSON.stringify(profile);
    if (this.#active?.fingerprint === fingerprint) return this.#active.access;
    if (this.#active) this.#retire();
    const epoch = this.#epoch;
    const lifetime = new AbortController();
    const inner =
      profile.kind === "app"
        ? new GithubAppAuth(
            {
              appId: profile.appId,
              installationId: profile.installationId,
              privateKeyPath: profile.privateKeyPath,
            },
            { fetcher: this.#fetch, coordinator: this.coordinator, now: this.#now },
          )
        : new UserCredentials(profile, this.store, this.#fetch, this.#now, this.coordinator);
    const assertCurrent = () => {
      this.#assert(epoch);
      check(lifetime.signal);
    };
    const combine = (signal?: AbortSignal | null) =>
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const credentials: GithubCredentials = {
      get quotaOwner() {
        assertCurrent();
        return inner.quotaOwner;
      },
      signal: lifetime.signal,
      get identity() {
        assertCurrent();
        return inner.identity;
      },
      async initialize(signal) {
        assertCurrent();
        await inner.initialize(combine(signal));
        assertCurrent();
      },
      async getToken(signal) {
        assertCurrent();
        const token = await inner.getToken(combine(signal));
        assertCurrent();
        return token;
      },
    };
    const fetcher: typeof fetch = (input, init) => {
      assertCurrent();
      return this.#fetch(input, { ...init, signal: combine(init?.signal) });
    };
    const access: GithubConnectionAccess = {
      profile: { ...profile },
      key: `${this.#instance}:${epoch}:${profile.id}`,
      owner: `pi-agent-github/profile/${profile.id}`,
      client: new GithubClient(credentials, { fetcher, coordinator: this.coordinator }),
      credentials,
      signal: lifetime.signal,
      assertCurrent,
    };
    this.#active = {
      access,
      fingerprint,
      lifetime,
      clear: () => inner.clear(),
      ...(inner instanceof GithubAppAuth
        ? { revokeCachedToken: (signal?: AbortSignal) => inner.revokeCachedToken(signal) }
        : {}),
    };
    return access;
  }
}
