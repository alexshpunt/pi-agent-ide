import type { Readable, Writable } from "node:stream";
import type { LspFileWatcherSubscriptions, WatchedFileChange } from "./file-watchers.js";

/** A language server process on one owner; its PID is never a local process identifier. */
export interface LspOwnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<{ readonly exitCode: number | null }>;
  readonly remote: { readonly target: string; readonly pid: number };
  stop(): Promise<void>;
}

/** Owner-supplied stdio and URI mapping. Creation is lazy and must not fall back locally. */
export interface LspOwnerTransport {
  start(input: {
    readonly rootUri: string;
    readonly command: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /** Cancels startup before ownership is transferred to the ready client. */
    readonly signal?: AbortSignal;
  }): Promise<LspOwnedProcess>;
  toServerUri(uri: string): string;
  fromServerUri(uri: string): string;
  /** Create lazy native subscriptions on this owner, never on the controller filesystem. */
  fileWatchers?(
    rootUri: string,
    changed: (change: WatchedFileChange) => void,
    failed: (error: Error) => void,
  ): LspFileWatcherSubscriptions;
}

const uriFields = new Set([
  "uri",
  "targetUri",
  "target",
  "oldUri",
  "newUri",
  "rootUri",
  "documentUri",
  "scopeUri",
  "baseUri",
]);
const uriMaps = new Set(["changes", "relatedDocuments"]);

/** Map protocol URI fields and URI-keyed edit/diagnostic maps, never source text or labels. */
export function mapLspUris(value: unknown, mapUri: (uri: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapLspUris(item, mapUri));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (uriFields.has(key) && typeof item === "string") return [key, mapUri(item)];
      if (uriMaps.has(key) && typeof item === "object" && item !== null && !Array.isArray(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item as Record<string, unknown>).map(([uri, edits]) => [
              mapUri(uri),
              mapLspUris(edits, mapUri),
            ]),
          ),
        ];
      }
      return [key, mapLspUris(item, mapUri)];
    }),
  );
}
