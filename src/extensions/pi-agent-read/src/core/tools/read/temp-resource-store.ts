import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentContent, ResourceResolutionAttempt, ResourceResolver } from "pi-agent-resource";

export const TEMP_RESOURCE_TTL_MS = 5 * 60_000;

interface TemporaryResource {
  activeReads: number;
  lastUsedAt: number;
  readonly filePath: string;
}

export interface TempResourceStoreOptions {
  readonly parentDirectory?: string;
  readonly ttlMs?: number;
}

export class TempResourceStore {
  readonly resolver: ResourceResolver;
  readonly #entries = new Map<string, TemporaryResource>();
  readonly #parentDirectory: string;
  readonly #ttlMs: number;
  #directoryReady: Promise<string> | undefined;
  #disposed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TempResourceStoreOptions = {}) {
    this.#parentDirectory = options.parentDirectory ?? tmpdir();
    this.#ttlMs = options.ttlMs ?? TEMP_RESOURCE_TTL_MS;

    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new TypeError("Temporary resource TTL must be a positive finite number");
    }

    this.resolver = {
      id: "temp",
      tryResolve: (source) => Promise.resolve(this.#resolve(source)),
    };
  }

  async save(text: string): Promise<string> {
    if (this.#disposed) {
      throw new Error("Temporary resource store is closed");
    }

    const directory = await this.#getDirectory();
    const id = randomUUID();
    const source = `temp:${id}`;
    const filePath = path.join(directory, `${id}.txt`);
    await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
    this.#entries.set(source, { activeReads: 0, filePath, lastUsedAt: Date.now() });
    this.#scheduleCleanup();
    return source;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#clearTimer();
    this.#entries.clear();
    const directoryReady = this.#directoryReady;

    if (directoryReady !== undefined) {
      await rm(await directoryReady, { recursive: true, force: true });
    }
  }

  #resolve(source: string): ResourceResolutionAttempt {
    if (!source.startsWith("temp:")) {
      return { kind: "not-handled" };
    }

    const entry = this.#entries.get(source);

    if (entry === undefined) {
      return {
        kind: "failed",
        error: new Error(`Temporary resource ${source} expired or does not exist`),
      };
    }

    if (entry.activeReads === 0 && entry.lastUsedAt + this.#ttlMs <= Date.now()) {
      this.#entries.delete(source);
      void unlink(entry.filePath).catch(() => {});
      this.#scheduleCleanup();
      return {
        kind: "failed",
        error: new Error(`Temporary resource ${source} expired or does not exist`),
      };
    }

    return {
      kind: "resolved",
      resource: {
        source,
        read: () => this.#read(source),
      },
    };
  }

  async #read(source: string): Promise<AgentContent> {
    const entry = this.#entries.get(source);

    if (entry === undefined) {
      throw new Error(`Temporary resource ${source} expired or does not exist`);
    }

    entry.activeReads += 1;
    this.#scheduleCleanup();

    try {
      return [{ type: "text" as const, text: await readFile(entry.filePath, "utf8") }];
    } finally {
      entry.activeReads -= 1;
      entry.lastUsedAt = Date.now();
      this.#scheduleCleanup();
    }
  }

  async #getDirectory(): Promise<string> {
    this.#directoryReady ??= (async () => {
      await mkdir(this.#parentDirectory, { recursive: true });
      return mkdtemp(path.join(this.#parentDirectory, "pi-agent-read-"));
    })();
    return this.#directoryReady;
  }

  #scheduleCleanup(): void {
    this.#clearTimer();

    if (this.#disposed) {
      return;
    }

    const now = Date.now();
    let nextDeadline: number | undefined;

    for (const entry of this.#entries.values()) {
      if (entry.activeReads > 0) {
        continue;
      }

      const deadline = entry.lastUsedAt + this.#ttlMs;
      nextDeadline = nextDeadline === undefined ? deadline : Math.min(nextDeadline, deadline);
    }

    if (nextDeadline === undefined) {
      return;
    }

    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.#removeExpired().catch(() => {
          this.#scheduleCleanup();
        });
      },
      Math.max(0, nextDeadline - now),
    );
    this.#timer.unref();
  }

  async #removeExpired(): Promise<void> {
    const now = Date.now();
    const expired = [...this.#entries].filter(
      ([, entry]) => entry.activeReads === 0 && entry.lastUsedAt + this.#ttlMs <= now,
    );

    await Promise.all(
      expired.map(async ([source, entry]) => {
        await unlink(entry.filePath).catch((error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
          }
        });
        this.#entries.delete(source);
      }),
    );
    this.#scheduleCleanup();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) {
      return;
    }

    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
