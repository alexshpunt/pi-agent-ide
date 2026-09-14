import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { URI } from "vscode-uri";

interface WatchPattern {
  globPattern: string | { baseUri: string | { uri: string }; pattern: string };
  kind?: number;
}

/** A native filesystem event translated to the LSP file change types. */
export interface WatchedFileChange {
  uri: string;
  type: 1 | 2 | 3;
}

/** Own the filesystem subscriptions requested by one language server. */
export class LspFileWatchers {
  private readonly registrations = new Map<string, FSWatcher[]>();

  private disposed = false;

  constructor(
    private readonly root: string,
    private readonly changed: (change: WatchedFileChange) => void,
    private readonly failed: (error: Error) => void,
  ) {}

  /** Install all patterns for one workspace/didChangeWatchedFiles registration. */
  async register(id: string, patterns: readonly WatchPattern[]): Promise<void> {
    const watchers: FSWatcher[] = [];
    try {
      for (const pattern of patterns) {
        const glob = pattern.globPattern;
        const root =
          typeof glob === "string"
            ? this.root
            : URI.parse(typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri.uri).fsPath;
        const expression = typeof glob === "string" ? glob : glob.pattern;
        const matches = (file: string) =>
          path.matchesGlob(path.isAbsolute(expression) ? path.join(root, file) : file, expression);
        const existing = new Set((await readdir(root, { recursive: true })).filter(matches));

        if (this.disposed) throw new Error("Language server file watchers are disposed");
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (!name || !matches(name)) return;
          void stat(path.join(root, name)).then(
            () => {
              if (!this.registrations.get(id)?.includes(watcher)) return;
              const type = existing.has(name) ? 2 : 1;
              existing.add(name);
              if ((pattern.kind ?? 7) & (type === 1 ? 1 : 2))
                this.changed({ uri: URI.file(path.join(root, name)).toString(), type });
            },
            (error: NodeJS.ErrnoException) => {
              if (!this.registrations.get(id)?.includes(watcher)) return;
              if (error.code !== "ENOENT") {
                this.failed(error);
                return;
              }
              if (existing.delete(name) && (pattern.kind ?? 7) & 4)
                this.changed({ uri: URI.file(path.join(root, name)).toString(), type: 3 });
            },
          );
        });
        watcher.on("error", this.failed);
        watchers.push(watcher);
      }
    } catch (error) {
      for (const watcher of watchers) watcher.close();
      throw error;
    }
    this.unregister(id);
    this.registrations.set(id, watchers);
  }

  /** Stop a server registration without affecting its other subscriptions. */
  unregister(id: string): void {
    for (const watcher of this.registrations.get(id) ?? []) watcher.close();
    this.registrations.delete(id);
  }

  /** Close all subscriptions when the server exits or the session ends. */
  dispose(): void {
    this.disposed = true;
    for (const id of this.registrations.keys()) this.unregister(id);
  }
}
