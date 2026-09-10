import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentContent, ResourceResolutionAttempt, ResourceResolver } from "pi-agent-resource";

export interface TempResourceStoreOptions {
  /** Parent folder for this store's private temporary directory. */
  readonly parentDirectory?: string;
}

/** Keeps temporary text resources isolated and readable until the owning runtime disposes it. */
export class TempResourceStore {
  readonly resolver: ResourceResolver;
  readonly #entries = new Map<string, string>();
  readonly #pendingSaves = new Set<Promise<string>>();
  readonly #parentDirectory: string;
  #directoryReady: Promise<string> | undefined;
  #disposal: Promise<void> | undefined;

  constructor(options: TempResourceStoreOptions = {}) {
    this.#parentDirectory = options.parentDirectory ?? tmpdir();
    this.resolver = {
      id: "temp",
      tryResolve: (source) => Promise.resolve(this.#resolve(source)),
    };
  }

  /** Saves text and returns a reference owned by this store. Rejects after disposal starts. */
  async save(text: string): Promise<string> {
    if (this.#disposal !== undefined) {
      throw new Error("Temporary resource store is closed");
    }

    const saving = this.#save(text);
    this.#pendingSaves.add(saving);
    try {
      return await saving;
    } finally {
      this.#pendingSaves.delete(saving);
    }
  }

  /** Closes the store, waits for pending saves, and removes its private directory. */
  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #save(text: string): Promise<string> {
    const directory = await this.#getDirectory();
    const id = randomUUID();
    const source = `temp:${id}`;
    const filePath = path.join(directory, `${id}.txt`);
    await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
    this.#entries.set(source, filePath);
    return source;
  }

  async #dispose(): Promise<void> {
    await Promise.allSettled(this.#pendingSaves);
    this.#entries.clear();
    if (this.#directoryReady !== undefined) {
      await rm(await this.#directoryReady, { recursive: true, force: true });
    }
  }

  #resolve(source: string): ResourceResolutionAttempt {
    if (!source.startsWith("temp:")) {
      return { kind: "not-handled" };
    }

    if (this.#disposal !== undefined || !this.#entries.has(source)) {
      return {
        kind: "failed",
        error: new Error(`Temporary resource ${source} does not exist in this runtime`),
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
    const filePath = this.#entries.get(source);
    if (this.#disposal !== undefined || filePath === undefined) {
      throw new Error(`Temporary resource ${source} does not exist in this runtime`);
    }
    return [{ type: "text", text: await readFile(filePath, "utf8") }];
  }

  async #getDirectory(): Promise<string> {
    this.#directoryReady ??= (async () => {
      await mkdir(this.#parentDirectory, { recursive: true });
      return mkdtemp(path.join(this.#parentDirectory, "pi-agent-read-"));
    })();
    return this.#directoryReady;
  }
}
