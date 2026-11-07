// @ts-check
// Answers to server-to-client requests, shared by LspClient and the shared server host.
// Plain JavaScript so the host can run outside Pi's TypeScript loader.
import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { URI } from "vscode-uri";

/** Version of the shared server host protocol; part of every shared server key. */
export const SHARED_SERVER_PROTOCOL = 2;

/** @typedef {import("./file-watchers.js").WatchPattern} WatchPattern */
/** @typedef {import("./file-watchers.js").WatchedFileChange} WatchedFileChange */

/**
 * One pattern of a registration. Paths are matched relative to base, which may be the root or
 * one of its ancestors; only files inside the root are ever watched.
 * @typedef {object} Matcher
 * @property {string} base
 * @property {string} expression
 * @property {number} kind
 */

/**
 * Own the filesystem subscriptions requested by one language server.
 *
 * All registrations share one watcher of the project tree (TreeWatcher). Servers ask for
 * patterns far outside the project, such as typescript watching every file under a parent
 * directory like /tmp; following them would watch unbounded trees. Patterns based outside the
 * root are narrowed to the root, or ignored when the root is not inside their base.
 */
export class LspFileWatchers {
  /** @type {Map<string, Matcher[]>} */
  #registrations = new Map();
  /** @type {TreeWatcher | undefined} */
  #watcher;
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
    this.#root = path.resolve(root);
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
    if (this.#disposed) throw new Error("Language server file watchers are disposed");
    /** @type {Matcher[]} */
    const matchers = [];
    for (const pattern of patterns) {
      const glob = pattern.globPattern;
      const base =
        typeof glob === "string"
          ? this.#root
          : path.resolve(
              URI.parse(typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri.uri).fsPath,
            );
      if (!within(base, this.#root) && !within(this.#root, base)) continue;
      matchers.push({
        base,
        expression: typeof glob === "string" ? glob : glob.pattern,
        kind: pattern.kind ?? 7,
      });
    }
    this.#registrations.set(id, matchers);
    if (matchers.length > 0) await this.#watch();
    else this.#release();
  }

  /**
   * Stop a server registration without affecting its other subscriptions.
   * @param {string} id
   * @returns {void}
   */
  unregister(id) {
    this.#registrations.delete(id);
    this.#release();
  }

  /**
   * Close all subscriptions when the server exits or the session ends.
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    this.#registrations.clear();
    this.#release();
  }

  /** @returns {Promise<void>} */
  #watch() {
    if (this.#watcher) return this.#watcher.ready;
    const watcher = new TreeWatcher(
      this.#root,
      (event, file) => this.#report(watcher, event, file),
      (error) => {
        if (this.#watcher === watcher) this.#failed(error);
      },
    );
    this.#watcher = watcher;
    return watcher.ready;
  }

  #release() {
    if ([...this.#registrations.values()].some((matchers) => matchers.length > 0)) return;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /**
   * Report one native event to the registrations that match it.
   * @param {TreeWatcher} watcher
   * @param {string} event
   * @param {string} file
   */
  #report(watcher, event, file) {
    const matching = (/** @type {number} */ type) =>
      [...this.#registrations.values()].some((matchers) =>
        matchers.some(
          (matcher) => (matcher.kind & (1 << (type - 1))) !== 0 && matches(matcher, file),
        ),
      );
    if (!matching(1) && !matching(2) && !matching(3)) return;
    void stat(file).then(
      (stats) => {
        if (this.#watcher !== watcher || stats.isDirectory()) return;
        // A rename event names a created or replaced file; a change event a modified one.
        const type = event === "rename" ? 1 : 2;
        if (matching(type)) this.#changed({ uri: URI.file(file).toString(), type });
      },
      /** @param {NodeJS.ErrnoException} error */
      (error) => {
        if (this.#watcher !== watcher) return;
        if (error.code !== "ENOENT") this.#failed(error);
        else if (matching(3)) this.#changed({ uri: URI.file(file).toString(), type: 3 });
      },
    );
  }
}

/**
 * @param {Matcher} matcher
 * @param {string} file
 */
function matches(matcher, file) {
  if (path.isAbsolute(matcher.expression)) return path.matchesGlob(file, matcher.expression);
  if (!within(file, matcher.base)) return false;
  return path.matchesGlob(path.relative(matcher.base, file), matcher.expression);
}

/**
 * Whether an absolute target is directory or inside it.
 * @param {string} target
 * @param {string} directory
 */
function within(target, directory) {
  return (
    target === directory ||
    target.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep)
  );
}

/** Directories never watched: Git internals change constantly and are no source files. */
const SKIPPED = new Set([".git"]);
/** Directories watched for their own entries only, such as packages added or removed. */
const SHALLOW = new Set(["node_modules"]);

/**
 * Watch a project tree without its Git directory or the contents of installed packages.
 *
 * Node's recursive fs.watch has no exclusions; on Linux it tracks every file of the tree in
 * JavaScript, which costs about 100 MiB and blocks for seconds on a repository with
 * node_modules. Linux therefore gets one native watch per included directory; other platforms
 * keep the native recursive watch and drop events from excluded directories.
 */
class TreeWatcher {
  /** @type {Map<string, import("node:fs").FSWatcher>} */
  #directories = new Map();
  /** @type {import("node:fs").FSWatcher | undefined} */
  #recursive;
  #closed = false;
  #event;
  #failed;
  /** Settles when the initial tree is watched. */
  ready = Promise.resolve();

  /**
   * @param {string} root
   * @param {(event: string, file: string) => void} event
   * @param {(error: Error) => void} failed
   */
  constructor(root, event, failed) {
    this.#event = event;
    this.#failed = failed;
    if (process.platform === "linux") {
      this.ready = this.#add(root);
      return;
    }
    const watcher = watch(root, { recursive: true }, (type, name) => {
      if (!name) return;
      const file = path.join(root, name);
      if (included(path.relative(root, file))) this.#event(type, file);
    });
    watcher.on("error", (error) => this.#failed(error));
    this.#recursive = watcher;
  }

  close() {
    this.#closed = true;
    this.#recursive?.close();
    for (const watcher of this.#directories.values()) watcher.close();
    this.#directories.clear();
  }

  /**
   * Watch a directory and the included directories below it.
   * @param {string} directory
   */
  async #add(directory) {
    if (this.#closed || this.#directories.has(directory)) return;
    /** @type {import("node:fs").FSWatcher} */
    let watcher;
    try {
      watcher = watch(directory, (type, name) => {
        if (name) this.#changed(type, path.join(directory, name));
      });
    } catch (error) {
      this.#report(error);
      return;
    }
    watcher.on("error", (error) => {
      watcher.close();
      if (this.#directories.get(directory) === watcher) this.#directories.delete(directory);
      this.#report(error);
    });
    this.#directories.set(directory, watcher);
    if (SHALLOW.has(path.basename(directory))) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      this.#report(error);
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !SKIPPED.has(entry.name))
        await this.#add(path.join(directory, entry.name));
  }

  /**
   * @param {string} type
   * @param {string} file
   */
  #changed(type, file) {
    if (this.#closed) return;
    this.#event(type, file);
    if (type !== "rename") return;
    const parent = path.basename(path.dirname(file));
    if (SKIPPED.has(path.basename(file)) || SHALLOW.has(parent)) return;
    void stat(file).then(
      (stats) => {
        if (stats.isDirectory()) void this.#add(file);
      },
      () => {
        for (const [directory, watcher] of this.#directories)
          if (within(directory, file)) {
            watcher.close();
            this.#directories.delete(directory);
          }
      },
    );
  }

  /** @param {unknown} error */
  #report(error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    // Directories removed or unreadable while the tree is read are simply not watched.
    if (this.#closed || code === "ENOENT" || code === "EACCES" || code === "EPERM") return;
    this.#failed(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Whether a root-relative path is outside skipped directories and package contents.
 * @param {string} relative
 */
function included(relative) {
  const segments = relative.split(path.sep);
  return !segments.some(
    (segment, index) =>
      SKIPPED.has(segment) || (SHALLOW.has(segment) && index < segments.length - 2),
  );
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
