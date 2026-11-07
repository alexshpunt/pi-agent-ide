// @ts-check
// Answers to server-to-client requests, shared by LspClient and the shared server host.
// Plain JavaScript so the host can run outside Pi's TypeScript loader.
import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { URI } from "vscode-uri";

/** Version of the shared server host protocol; part of every shared server key. */
export const SHARED_SERVER_PROTOCOL = 1;

/** @typedef {import("./file-watchers.js").WatchPattern} WatchPattern */
/** @typedef {import("./file-watchers.js").WatchedFileChange} WatchedFileChange */

/** Own the filesystem subscriptions requested by one language server. */
export class LspFileWatchers {
  /** @type {Map<string, import("node:fs").FSWatcher[]>} */
  #registrations = new Map();
  #disposed = false;
  #root;
  #changed;
  #failed;

  /**
   * @param {string} root
   * @param {(change: WatchedFileChange) => void} changed
   * @param {(error: Error) => void} failed
   */
  constructor(root, changed, failed) {
    this.#root = root;
    this.#changed = changed;
    this.#failed = failed;
  }

  /**
   * Install all patterns for one workspace/didChangeWatchedFiles registration.
   * @param {string} id
   * @param {readonly WatchPattern[]} patterns
   * @returns {Promise<void>}
   */
  async register(id, patterns) {
    /** @type {import("node:fs").FSWatcher[]} */
    const watchers = [];
    try {
      for (const pattern of patterns) {
        const glob = pattern.globPattern;
        const root =
          typeof glob === "string"
            ? this.#root
            : URI.parse(typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri.uri).fsPath;
        const expression = typeof glob === "string" ? glob : glob.pattern;
        /** @param {string} file */
        const matches = (file) =>
          path.matchesGlob(path.isAbsolute(expression) ? path.join(root, file) : file, expression);
        const existing = new Set((await readdir(root, { recursive: true })).filter(matches));

        if (this.#disposed) throw new Error("Language server file watchers are disposed");
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (!name || !matches(name)) return;
          void stat(path.join(root, name)).then(
            () => {
              if (!this.#registrations.get(id)?.includes(watcher)) return;
              const type = existing.has(name) ? 2 : 1;
              existing.add(name);
              if ((pattern.kind ?? 7) & (type === 1 ? 1 : 2))
                this.#changed({ uri: URI.file(path.join(root, name)).toString(), type });
            },
            /** @param {NodeJS.ErrnoException} error */
            (error) => {
              if (!this.#registrations.get(id)?.includes(watcher)) return;
              if (error.code !== "ENOENT") {
                this.#failed(error);
                return;
              }
              if (existing.delete(name) && (pattern.kind ?? 7) & 4)
                this.#changed({ uri: URI.file(path.join(root, name)).toString(), type: 3 });
            },
          );
        });
        watcher.on("error", this.#failed);
        watchers.push(watcher);
      }
    } catch (error) {
      for (const watcher of watchers) watcher.close();
      throw error;
    }
    this.unregister(id);
    this.#registrations.set(id, watchers);
  }

  /**
   * Stop a server registration without affecting its other subscriptions.
   * @param {string} id
   * @returns {void}
   */
  unregister(id) {
    for (const watcher of this.#registrations.get(id) ?? []) watcher.close();
    this.#registrations.delete(id);
  }

  /**
   * Close all subscriptions when the server exits or the session ends.
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    for (const id of this.#registrations.keys()) this.unregister(id);
  }
}

/**
 * Answer workspace/configuration items from settings fixed for one server configuration.
 * @param {unknown} settings
 * @param {readonly { section?: string }[]} items
 * @returns {unknown[]}
 */
export function configurationItems(settings, items) {
  return items.map((item) => {
    let value = settings ?? null;
    for (const segment of item.section?.split(".").filter(Boolean) ?? []) {
      value =
        typeof value === "object" && value !== null
          ? (/** @type {Record<string, unknown>} */ (value)[segment] ?? null)
          : null;
    }
    return value;
  });
}
