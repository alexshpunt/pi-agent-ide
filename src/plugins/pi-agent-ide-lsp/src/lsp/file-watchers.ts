/** One language-server glob and its requested create/change/delete event mask. */
export interface WatchPattern {
  globPattern: string | { baseUri: string | { uri: string }; pattern: string };
  kind?: number;
}

/** A native filesystem event translated to the LSP file change types. */
export interface WatchedFileChange {
  uri: string;
  type: 1 | 2 | 3;
}

/** Subscriptions supplied by the filesystem owner; release may involve a remote process. */
export interface LspFileWatcherSubscriptions {
  register(id: string, patterns: readonly WatchPattern[]): Promise<void>;
  unregister(id: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export { LspFileWatchers } from "./server-request-handlers.mjs";
