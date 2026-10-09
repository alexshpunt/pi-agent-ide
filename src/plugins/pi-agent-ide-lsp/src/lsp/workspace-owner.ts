import type { LspOwnerTransport } from "./owner-transport.js";

/** Workspace I/O and process creation supplied by the resource owner. */
export interface LspWorkspaceOwner {
  transport(rootUri: string): LspOwnerTransport;
  readText(source: string, signal?: AbortSignal): Promise<string>;
  /** Text and an opaque content/identity revision captured by the source owner. */
  readSnapshot(source: string, signal?: AbortSignal): Promise<{ content: string; version: string }>;
  readBytes(source: string, signal?: AbortSignal): Promise<Uint8Array>;
  exists(source: string, signal?: AbortSignal): Promise<boolean>;
  isFile(source: string, signal?: AbortSignal): Promise<boolean>;
  entries(
    source: string,
    signal?: AbortSignal,
  ): Promise<readonly { name: string; kind: "file" | "directory" | "other" }[]>;
}
