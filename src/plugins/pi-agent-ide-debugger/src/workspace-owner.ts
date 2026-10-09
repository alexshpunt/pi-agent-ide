import type { DapClient } from "./dap-client.js";
import type { DebugSessionOptions } from "./session-manager.js";

/** A prepared adapter on the selected workspace, with native launch arguments. */
export interface OwnedDebugAdapter {
  readonly client: DapClient;
  /** Open a reverse child session on the same owned adapter, never on a controller socket. */
  readonly connectChild?: () => Promise<DapClient>;
  readonly adapterID: string;
  readonly request: "launch" | "attach";
  readonly launch: Readonly<Record<string, unknown>>;
  readonly remote?: { readonly target: string; readonly pid: number; readonly identity?: string };
}

/** Own source reads and protocol paths without interpreting document or evaluation text. */
export interface DebugWorkspaceOwner {
  /** Stable configured binding. A rebound workspace must not operate an old session. */
  readonly key: string;
  readText(source: string): Promise<string>;
  /** Convert only a source resource on this owner into its native protocol path. */
  serverPath(source: string): string;
  /** Convert only an adapter source path into this owner's canonical resource. */
  resourcePath(path: string): string;
  prepare(options: DebugSessionOptions, signal?: AbortSignal): Promise<OwnedDebugAdapter>;
}

/** Claim an explicitly owned workspace; return undefined only for local workspaces. */
export type DebugWorkspaceOwnerResolver = (cwd: string) => DebugWorkspaceOwner | undefined;
