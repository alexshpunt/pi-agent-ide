import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { assertWindowsPrivatePath } from "./windows-private-path.ts";
import {
  GithubRateLimitError,
  isGithubRateLimitResponse,
  rateLimitInfoFromHeaders,
  safeRateLimitInfo,
  type GithubRateLimitInfo,
} from "./rate-limit.ts";

interface State {
  version: 1;
  nextMutationAt: number;
  limits: Partial<Record<string, GithubRateLimitInfo>>;
}
export interface GithubCoordinatorOptions {
  /** null is an isolated, memory-only coordinator for embedded users and tests. */
  directory?: string | null;
  now?: () => number;
  mutationIntervalMs?: number;
  maxQueue?: number;
  waitTimeoutMs?: number;
}
/** Admission failures prove that this operation has not reached the HTTP boundary. */
export class GithubNotSentError extends Error {
  readonly effect = "not-applied";
  constructor(readonly code: string) {
    super(code);
    this.name = "GithubNotSentError";
  }
}
function abort(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  const timedOut = isRecord(reason) && reason.name === "TimeoutError";
  throw new GithubNotSentError(timedOut ? "GH_TIMEOUT" : "GH_CANCELLED");
}
function unsafe(): never {
  throw new GithubNotSentError("GH_RATE_STATE_UNSAFE");
}
function bucket(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname === "/graphql"
    ? "graphql"
    : pathname.startsWith("/search/code")
      ? "code_search"
      : pathname.startsWith("/search/")
        ? "search"
        : "core";
}
async function dispatched<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener("abort", cancelled, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
    if (signal.aborted) cancelled();
  });
}
function empty(): State {
  return { version: 1, nextMutationAt: 0, limits: Object.create(null) as State["limits"] };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function releaseRequest(
  release: (() => Promise<void>) | undefined,
  sent: boolean,
): Promise<void> {
  try {
    await release?.();
  } catch (error) {
    if (sent && error instanceof GithubNotSentError) throw new Error(error.code, { cause: error });
    throw error;
  }
}
function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Serial admission per upstream owner/host, shared with other processes when backed by a directory.
 * Only safe deadlines/counters and a mutation start timestamp are persisted; never credentials or URLs.
 * HTTP is never retried. The lease covers the send and response headers, not subsequent caller work.
 */
export class GithubRequestCoordinator {
  readonly #directory: string | null;
  readonly #now: () => number;
  readonly #interval: number;
  readonly #maxQueue: number;
  readonly #wait: number;
  readonly #states = new Map<string, State>();
  readonly #busy = new Set<string>();
  readonly #queued = new Map<string, number>();
  constructor(options: GithubCoordinatorOptions = {}) {
    const config = process.env.PI_GITHUB_CONFIG_DIR;
    if (
      options.directory === undefined &&
      config !== undefined &&
      (!config.trim() || !path.isAbsolute(config))
    )
      unsafe();
    this.#directory =
      options.directory === null
        ? null
        : path.resolve(
            options.directory ??
              path.join(
                config ?? path.join(homedir(), ".config", "pi-agent-github"),
                "rate-limits",
              ),
          );
    this.#now = options.now ?? Date.now;
    this.#interval = options.mutationIntervalMs ?? 1000;
    this.#maxQueue = options.maxQueue ?? 64;
    this.#wait = options.waitTimeoutMs ?? 15_000;
    if (
      ![this.#interval, this.#maxQueue, this.#wait].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      unsafe();
  }
  #key(owner: string, url: string): string {
    if (!owner || owner.length > 256 || /[\x00-\x1f\x7f]/u.test(owner)) unsafe();
    const origin = new URL(url).origin;
    const quotaHost = origin === "https://uploads.github.com" ? "https://api.github.com" : origin;
    return createHash("sha256").update(quotaHost).update("\0").update(owner).digest("hex");
  }
  #blocked(state: State, resource: string): void {
    const now = this.#now();
    const global = state.limits["*"];
    const specific = state.limits[`b:${resource}`];
    const blocked = (global?.resetAt ?? 0) >= (specific?.resetAt ?? 0) ? global : specific;
    const resetAt = blocked?.resetAt;
    if (resetAt !== undefined && resetAt > now)
      throw new GithubRateLimitError({
        ...blocked,
        retryAfterMs: Math.min(86_400_000, Math.ceil(resetAt - now)),
      });
  }
  /** A known owner can fail before authentication or refresh consumes another request. */
  async check(owner: string, url: string): Promise<void> {
    await this.#prepare();
    this.#blocked(await this.#read(this.#key(owner, url)), bucket(url));
  }
  async fetch(
    owner: string,
    url: string,
    init: RequestInit,
    options: { fetcher: typeof fetch; readOnly?: boolean },
  ): Promise<Response> {
    const key = this.#key(owner, url);
    const signal = init.signal ?? undefined;
    const queued = this.#queued.get(key) ?? 0;
    if (queued >= this.#maxQueue) throw new GithubNotSentError("GH_RATE_QUEUE_FULL");
    this.#queued.set(key, queued + 1);
    let release: (() => Promise<void>) | undefined;
    let sent = false;
    try {
      await this.#prepare();
      const start = Date.now();
      while (!release) {
        abort(signal);
        this.#blocked(await this.#read(key), bucket(url));
        release = await this.#lease(key);
        if (!release) {
          if (Date.now() - start >= this.#wait) throw new GithubNotSentError("GH_TIMEOUT");
          await this.#pause(20, signal);
        }
      }
      const state = await this.#read(key);
      this.#blocked(state, bucket(url));
      const readOnly =
        options.readOnly ?? ["GET", "HEAD", "OPTIONS"].includes(init.method ?? "GET");
      if (!readOnly) {
        const wait = Math.max(0, state.nextMutationAt - this.#now());
        if (wait > this.#wait) throw new GithubNotSentError("GH_TIMEOUT");
        await this.#pause(wait, signal);
        abort(signal);
        state.nextMutationAt = this.#now() + this.#interval;
        await this.#write(key, state);
      }
      abort(signal);
      sent = true;
      const response = await dispatched(options.fetcher(url, init), signal);
      // A successful final request is allowed to exhaust its budget. Only later sends are blocked.
      if (this.#record(state, url, response)) await this.#write(key, state);
      return response;
    } catch (error) {
      if (sent && error instanceof GithubNotSentError)
        throw new Error(error.code, { cause: error });
      throw error;
    } finally {
      this.#queued.set(key, Math.max(0, (this.#queued.get(key) ?? 1) - 1));
      if (!this.#queued.get(key)) this.#queued.delete(key);
      await releaseRequest(release, sent);
    }
  }
  /** Record limits discovered while parsing a response, without issuing or replaying HTTP. */
  async observe(owner: string, url: string, response: Response, data?: unknown): Promise<void> {
    if (
      !isGithubRateLimitResponse(response.status, response.headers, data) &&
      rateLimitInfoFromHeaders(response.headers, this.#now()).requestsRemaining !== 0
    )
      return;
    const key = this.#key(owner, url);
    await this.#prepare();
    const start = Date.now();
    let release: (() => Promise<void>) | undefined;
    while (!(release = await this.#lease(key))) {
      if (Date.now() - start >= this.#wait) throw new GithubNotSentError("GH_RATE_STATE_UNSAFE");
      await delay(20);
    }
    try {
      const state = await this.#read(key);
      if (this.#record(state, url, response, data)) await this.#write(key, state);
    } finally {
      await release();
    }
  }
  #record(state: State, url: string, response: Response, data?: unknown): boolean {
    const now = this.#now();
    const limited = isGithubRateLimitResponse(response.status, response.headers, data);
    const info = rateLimitInfoFromHeaders(response.headers, now, limited);
    if (!limited && info.requestsRemaining !== 0) return false;
    const resetAt = Math.max(info.resetAt ?? 0, now + (info.retryAfterMs ?? 60_000));
    const primary = info.requestsRemaining === 0;
    const resource = info.endpoint ?? bucket(url);
    const slot = primary ? `b:${resource}` : "*";
    if ((state.limits[slot]?.resetAt ?? 0) < resetAt)
      state.limits[slot] = {
        ...info,
        resetAt,
        retryAfterMs: Math.min(86_400_000, Math.ceil(resetAt - now)),
      };
    for (const [key, value] of Object.entries(state.limits))
      if ((value?.resetAt ?? 0) <= this.#now()) delete state.limits[key];
    if (Object.keys(state.limits).length > 32) unsafe();
    return true;
  }
  async #pause(ms: number, signal?: AbortSignal): Promise<void> {
    abort(signal);
    if (ms > 0)
      try {
        await delay(ms, undefined, { signal });
      } catch {
        abort(signal);
        throw new GithubNotSentError("GH_TIMEOUT");
      }
  }
  async #prepare(): Promise<void> {
    if (!this.#directory) return;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.#directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
      if (process.platform === "win32") await assertWindowsPrivatePath(this.#directory);
      else if (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) unsafe();
    } catch {
      unsafe();
    }
  }
  async #lease(key: string): Promise<(() => Promise<void>) | undefined> {
    if (this.#busy.has(key)) return;
    this.#busy.add(key);
    if (!this.#directory)
      return async () => {
        this.#busy.delete(key);
      };
    try {
      let compromised = false;
      const release = await lockfile.lock(path.join(this.#directory, key), {
        realpath: false,
        retries: 0,
        stale: 60_000,
        update: 10_000,
        onCompromised: () => {
          compromised = true;
        },
      });
      return async () => {
        try {
          await release();
          if (compromised) unsafe();
        } finally {
          this.#busy.delete(key);
        }
      };
    } catch (error) {
      this.#busy.delete(key);
      if (error && typeof error === "object" && "code" in error && error.code === "ELOCKED") return;
      unsafe();
    }
  }
  async #read(key: string): Promise<State> {
    if (!this.#directory) return structuredClone(this.#states.get(key) ?? empty());
    let file;
    try {
      const filename = path.join(this.#directory, `${key}.json`);
      if (process.platform === "win32") await assertWindowsPrivatePath(filename);
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32_768) unsafe();
      if (process.platform === "win32") {
        const named = await lstat(filename);
        if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) unsafe();
        await assertWindowsPrivatePath(filename);
      } else if (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) unsafe();
      const data: unknown = JSON.parse(await file.readFile("utf8"));
      if (
        !isRecord(data) ||
        data.version !== 1 ||
        typeof data.nextMutationAt !== "number" ||
        !Number.isSafeInteger(data.nextMutationAt) ||
        data.nextMutationAt < 0 ||
        !isRecord(data.limits) ||
        Object.keys(data.limits).length > 32
      )
        unsafe();
      const state = empty();
      state.nextMutationAt = data.nextMutationAt;
      for (const [slot, value] of Object.entries(data.limits)) {
        if (slot !== "*" && !/^b:[A-Za-z0-9_:-]{1,80}$/u.test(slot)) unsafe();
        const info = safeRateLimitInfo(value);
        if (!info || !info.resetAt) unsafe();
        state.limits[slot] = info;
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return empty();
      return unsafe();
    } finally {
      await file?.close();
    }
  }
  async #write(key: string, state: State): Promise<void> {
    if (!this.#directory) {
      this.#states.set(key, structuredClone(state));
      return;
    }
    const file = path.join(this.#directory, `${key}.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (process.platform === "win32") await assertWindowsPrivatePath(file);
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(file, path.join(this.#directory, `${key}.json`));
    } catch {
      unsafe();
    } finally {
      await unlink(file).catch((error) => {
        if (!isMissing(error)) unsafe();
      });
    }
  }
}

/** Default production state is shared even when callers construct independent clients. */
export const githubRequestCoordinator = new GithubRequestCoordinator();
