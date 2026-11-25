import { createHash, randomUUID } from "node:crypto";
import { constants, unlinkSync, rmdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { assertSafePrivatePath } from "./managed-connection.ts";
import { assertWindowsPrivatePath } from "./windows-private-path.ts";
import { isConnectionFailure } from "./lib/connection-failure.ts";
import { asRecord } from "./types.ts";
import {
  LinearRateLimitError,
  MAX_COOLDOWN_MS,
  rateLimitInfoFromHeaders,
  safeRateLimitInfo,
  type RateLimitInfo,
} from "./rate-limit.ts";

export interface PreflightScope {
  connectionId: string;
  epoch: string;
  server: string;
}
export interface PreflightCacheOptions {
  directory: string;
  scope: () => Promise<PreflightScope | undefined>;
  now?: () => number;
  ttlMs?: number;
}
interface Entry {
  version: 1;
  createdAt: number;
  expiresAt: number;
  value: unknown;
}
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 5 * 60_000;
// Small wall-clock corrections must not invalidate otherwise valid cache entries.
const CLOCK_SKEW_TOLERANCE_MS = 2000;
function fail(code = "LINEAR_PREFLIGHT_CACHE_UNSAFE"): never {
  throw new Error(code);
}
const missing = (error: unknown) => asRecord(error)?.code === "ENOENT";
const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) fail();
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Disposable public metadata, never credentials or cached mutation results. */
export class LinearPreflightCache {
  readonly options: PreflightCacheOptions;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private contextOwner: string | null | undefined;
  constructor(options: PreflightCacheOptions) {
    this.options = options;
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > DEFAULT_TTL_MS)
      fail("LINEAR_PREFLIGHT_CACHE_INVALID");
  }
  async get<T>(
    key: string,
    load: () => Promise<T>,
    valid: (value: unknown) => value is T,
  ): Promise<T> {
    const scope = await this.currentScope();
    // Legacy mixed-principal configuration has no safe shared cache identity.
    if (!scope) {
      const value = await load();
      await this.currentScope();
      return value;
    }
    const owner = hash(scope);
    await this.prepare();
    const file = path.join(this.directory, hash([scope, key]) + ".json");
    const read = async (): Promise<Entry | undefined> => {
      const entry = await this.read(file);
      const now = this.now();
      return entry &&
        entry.createdAt <= now + CLOCK_SKEW_TOLERANCE_MS &&
        entry.expiresAt > now &&
        entry.expiresAt - entry.createdAt <= this.ttlMs &&
        valid(entry.value)
        ? entry
        : undefined;
    };
    const unchanged = async () => {
      const current = await this.currentScope();
      if (!current || hash(current) !== owner) fail("LINEAR_AUTH_CONTEXT_CHANGED");
    };
    const hit = await read();
    if (hit) {
      await unchanged();
      return hit.value as T;
    }
    return this.lock(file, async () => {
      const raced = await read();
      if (raced) {
        await unchanged();
        return raced.value as T;
      }
      await unchanged();
      const value = await load();
      if (!valid(value)) fail("LINEAR_INVALID_RESPONSE");
      await unchanged();
      const createdAt = this.now();
      await this.write(file, { version: 1, createdAt, expiresAt: createdAt + this.ttlMs, value });
      await this.prune(file);
      return value;
    });
  }
  async fetch(
    request: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    fetchImpl: typeof fetch = fetch,
  ): Promise<Response> {
    const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    signal?.throwIfAborted();
    const scope = await this.currentScope();
    let file: string | undefined;
    if (scope) {
      await this.prepare();
      const rateFile = this.rateFile(
        scope,
        request instanceof Request ? request.url : String(request),
      );
      file = rateFile;
      // Admission also proves the private cache is writable before sending traffic.
      await this.lock(path.join(this.directory, "rates"), async () => {
        const entry = await this.read(rateFile);
        const now = this.now();
        const info = this.activeRate(entry, now);
        await this.currentScope();
        if (entry && info)
          throw new LinearRateLimitError({
            ...info,
            retryAfterMs: entry.expiresAt - Math.max(now, entry.createdAt),
          });
        await this.ensureRateCapacity(rateFile);
      });
    }
    signal?.throwIfAborted();
    const response = await fetchImpl(request, init);
    const now = this.now();
    const limited = response.status === 429;
    const rate = rateLimitInfoFromHeaders(response.headers, now, limited);
    const exhausted = [
      rate.requestsRemaining,
      rate.complexityRemaining,
      rate.endpointRemaining,
    ].includes(0);
    if (limited && !rate.retryAfterMs) {
      rate.retryAfterMs = 1000;
      rate.resetAt = now + 1000;
    }
    const cleanup = { failure: undefined as Error | undefined };
    try {
      if (file && scope && (limited || exhausted) && rate.resetAt && rate.resetAt > now)
        await this.storeRate(file, hash(scope), rate, now);
    } catch (error) {
      const code =
        error instanceof Error && /^LINEAR_PREFLIGHT_CACHE_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "LINEAR_PREFLIGHT_CACHE_UNSAFE";
      cleanup.failure = isConnectionFailure(error) ? error : new Error(code);
    } finally {
      if (limited || cleanup.failure) {
        try {
          await response.body?.cancel();
        } catch {
          cleanup.failure ??= new Error("LINEAR_RESPONSE_CLEANUP_FAILED");
        }
      }
    }
    const { failure } = cleanup;
    if (failure && (!limited || isConnectionFailure(failure))) throw failure;
    if (limited) throw new LinearRateLimitError(rate, failure ? { cause: failure } : undefined);
    return response;
  }
  private async currentScope(): Promise<PreflightScope | undefined> {
    const scope = await this.options.scope();
    const owner = scope ? hash(scope) : null;
    if (this.contextOwner !== undefined && this.contextOwner !== owner)
      fail("LINEAR_AUTH_CONTEXT_CHANGED");
    this.contextOwner = owner;
    return scope;
  }
  private rateFile(scope: PreflightScope, server: string): string {
    const address = new URL(server);
    return path.join(
      this.directory,
      hash([scope, "cooldown", address.origin + address.pathname + address.search]) + ".rate.json",
    );
  }
  private async storeRate(
    file: string,
    owner: string,
    rate: RateLimitInfo,
    now: number,
  ): Promise<void> {
    const deadline = rate.resetAt;
    if (deadline === undefined || deadline <= now) return;
    await this.lock(path.join(this.directory, "rates"), async () => {
      const current = await this.currentScope();
      if (!current || hash(current) !== owner) fail("LINEAR_AUTH_CONTEXT_CHANGED");
      await this.ensureRateCapacity(file);
      const previous = await this.read(file);
      const previousInfo = this.activeRate(previous, now);
      const active = previousInfo ? previous : undefined;
      const until = Math.max(deadline, active?.expiresAt ?? 0);
      const createdAt = active && active.expiresAt >= deadline ? active.createdAt : now;
      const value: RateLimitInfo = {
        ...previousInfo,
        ...rate,
        resetAt: until,
        retryAfterMs: until - createdAt,
      };
      await this.write(file, { version: 1, createdAt, expiresAt: until, value });
    });
  }
  /** Record a decoded rate signal without repeating its request or storing its body. */
  async rateLimited(server: string, source: Headers | RateLimitInfo): Promise<never> {
    const scope = await this.currentScope();
    const now = this.now();
    const rate =
      source instanceof Headers
        ? rateLimitInfoFromHeaders(source, now, true)
        : (safeRateLimitInfo(source) ?? {});
    if (!(source instanceof Headers)) {
      const delay = rate.retryAfterMs ?? (rate.resetAt ?? now) - now;
      rate.retryAfterMs = delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : 1000;
      rate.resetAt = now + rate.retryAfterMs;
    }
    if (!rate.retryAfterMs) {
      rate.retryAfterMs = 1000;
      rate.resetAt = now + 1000;
    }
    let failure: Error | undefined;
    try {
      if (scope) {
        await this.prepare();
        await this.storeRate(this.rateFile(scope, server), hash(scope), rate, now);
      }
    } catch (error) {
      if (isConnectionFailure(error)) throw error;
      failure = new Error("LINEAR_PREFLIGHT_CACHE_UNSAFE");
    }
    throw new LinearRateLimitError(rate, failure ? { cause: failure } : undefined);
  }
  private activeRate(entry: Entry | undefined, now: number): RateLimitInfo | undefined {
    if (
      !entry ||
      entry.createdAt > now + CLOCK_SKEW_TOLERANCE_MS ||
      entry.expiresAt <= now ||
      entry.expiresAt - entry.createdAt > MAX_COOLDOWN_MS
    )
      return;
    const info = safeRateLimitInfo(entry.value);
    return info?.resetAt === entry.expiresAt &&
      info.retryAfterMs === entry.expiresAt - entry.createdAt
      ? info
      : undefined;
  }
  private async rateNames(): Promise<string[]> {
    return (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9]{64}\.rate\.json$/u.test(name),
    );
  }
  // Rate writers and capacity cleanup hold the same directory-wide owner-safe lock.
  // Active cooldowns are never evicted just to admit another principal.
  private async ensureRateCapacity(file: string): Promise<void> {
    const names = await this.rateNames();
    if (names.length < MAX_ENTRIES || names.includes(path.basename(file))) return;
    const now = this.now();
    await Promise.all(
      names.map(async (name) => {
        const candidate = path.join(this.directory, name);
        const entry = await this.read(candidate);
        if (!this.activeRate(entry, now)) await rm(candidate, { force: true });
      }),
    );
    if ((await this.rateNames()).length >= MAX_ENTRIES) fail("LINEAR_PREFLIGHT_CACHE_BUSY");
  }
  private async safe(file: string): Promise<void> {
    try {
      await assertSafePrivatePath(file);
    } catch {
      fail();
    }
  }
  private async windowsPrivate(file: string): Promise<void> {
    try {
      await assertWindowsPrivatePath(file);
    } catch {
      fail();
    }
  }
  private async prepare(): Promise<void> {
    await this.safe(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.safe(this.directory);
    const info = await lstat(this.directory);
    if (!info.isDirectory() || (process.platform !== "win32" && info.mode & 0o077)) fail();
    await this.windowsPrivate(this.directory);
    await this.cleanOrphans();
  }
  private async cleanOrphans(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      const file = path.join(this.directory, name);
      const staged =
        /^(?:[a-f0-9]{64}(?:\.rate)?\.json|rates)\.lock\.(([1-9][0-9]*)-[a-f0-9-]{36}\.owner)\.tmp$/u.exec(
          name,
        );
      if (staged) {
        if (!alive(Number(staged[2]))) {
          await this.safe(file);
          await this.releaseLock(file, staged[1]);
          await this.removeEmptyDirectory(file);
        }
        continue;
      }
      if (/^(?:[a-f0-9]{64}(?:\.rate)?\.json|rates)\.lock$/u.test(name)) {
        await this.reapDeadLock(file);
        continue;
      }
      const write = /^[a-f0-9]{64}(?:\.rate)?\.json\.([1-9][0-9]*)-[a-f0-9-]{36}\.tmp$/u.exec(name);
      if (write && !alive(Number(write[1]))) {
        await this.safe(file);
        try {
          await unlink(file);
        } catch (error) {
          if (!missing(error)) fail();
        }
      }
    }
  }
  private async removeEmptyDirectory(directory: string): Promise<void> {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        fail();
    }
  }
  private async read(file: string): Promise<Entry | undefined> {
    await this.safe(file);
    let handle: FileHandle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) return undefined;
      fail();
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > MAX_BYTES ||
        (process.platform !== "win32" && info.mode & 0o077)
      )
        fail();
      await this.windowsPrivate(file);
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile("utf8"));
      } catch {
        return undefined;
      }
      const entry = asRecord(value);
      if (
        entry?.version !== 1 ||
        typeof entry.createdAt !== "number" ||
        !Number.isSafeInteger(entry.createdAt) ||
        typeof entry.expiresAt !== "number" ||
        !Number.isSafeInteger(entry.expiresAt) ||
        entry.expiresAt <= entry.createdAt
      )
        return undefined;
      return {
        version: 1,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        value: entry.value,
      };
    } finally {
      await handle.close();
    }
  }
  private async write(file: string, value: Entry): Promise<void> {
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > MAX_BYTES) fail("LINEAR_PREFLIGHT_CACHE_TOO_LARGE");
    await this.safe(file);
    const temporary = file + "." + process.pid + "-" + randomUUID() + ".tmp";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await this.windowsPrivate(temporary);
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.safe(file);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async prune(current: string): Promise<void> {
    const names = (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name),
    );
    if (names.length <= MAX_ENTRIES) return;
    const entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.directory, name);
        const info = await lstat(file).catch((error) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (info?.isSymbolicLink()) fail();
        return { file, time: info?.mtimeMs ?? Infinity };
      }),
    );
    for (const entry of entries
      .filter((entry) => entry.file !== current)
      .sort((a, b) => a.time - b.time)
      .slice(0, names.length - MAX_ENTRIES))
      await rm(entry.file, { force: true });
  }
  private async lock<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const lock = file + ".lock";
    const owner = process.pid + "-" + randomUUID() + ".owner";
    const temporary = lock + "." + owner + ".tmp";
    // A published lock is never empty: an atomic rename installs its unique owner marker.
    // rmdir cannot remove a replacement lock while that marker is present.
    const cleanup = () => {
      for (const directory of [lock, temporary]) {
        try {
          unlinkSync(path.join(directory, owner));
        } catch {
          continue;
        }
        try {
          rmdirSync(directory);
        } catch {
          /* A replacement owner keeps its directory. */
        }
      }
    };
    const terminate = () => {
      cleanup();
      process.exit(143);
    };
    process.once("exit", cleanup);
    process.once("SIGTERM", terminate);
    try {
      await this.safe(lock);
      await mkdir(temporary, { mode: 0o700 });
      await writeFile(path.join(temporary, owner), "", { flag: "wx", mode: 0o600 });
      const started = Date.now();
      for (;;) {
        await this.safe(lock);
        try {
          await rename(temporary, lock);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows reports EPERM when the destination is an existing non-empty directory.
          // The reaper validates the lock before waiting or removing a dead owner.
          if (
            !["EEXIST", "ENOTEMPTY"].includes(code ?? "") &&
            !(process.platform === "win32" && code === "EPERM")
          )
            fail();
        }
        await this.reapDeadLock(lock);
        if (Date.now() - started >= 30_000) fail("LINEAR_PREFLIGHT_CACHE_BUSY");
        await delay(25);
      }
      return await operation();
    } finally {
      process.removeListener("exit", cleanup);
      process.removeListener("SIGTERM", terminate);
      await this.releaseLock(lock, owner);
      await this.releaseLock(temporary, owner);
    }
  }
  private async releaseLock(directory: string, owner: string): Promise<void> {
    try {
      await unlink(path.join(directory, owner));
    } catch (error) {
      if (missing(error)) return;
      fail();
    }
    await this.removeEmptyDirectory(directory);
  }
  private async reapDeadLock(directory: string): Promise<void> {
    await this.safe(directory);
    let names: string[];
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || (process.platform !== "win32" && info.mode & 0o077)) fail();
      await this.windowsPrivate(directory);
      names = await readdir(directory);
    } catch (error) {
      if (missing(error)) return;
      // A live owner can release its lock while Windows ACL inspection is running.
      try {
        await lstat(directory);
      } catch (recheck) {
        if (missing(recheck)) return;
      }
      fail();
    }
    if (names.length === 0) {
      await this.removeEmptyDirectory(directory);
      return;
    }
    if (names.length !== 1) fail();
    const owner = names[0];
    const match = /^([1-9][0-9]*)-[a-f0-9-]{36}\.owner$/u.exec(owner);
    if (!match) fail();
    if (alive(Number(match[1]))) return;
    // Only the reaper removing this exact marker may remove the nonempty lock.
    await this.releaseLock(directory, owner);
  }
}
