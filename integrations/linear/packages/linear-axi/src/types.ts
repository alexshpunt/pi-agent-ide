import type { Readable, Writable } from "node:stream";
import type { ManagedConnection } from "./managed-connection.ts";
import type { NativeSearchClient } from "./graphql.ts";
import type { StorageClient } from "./storage.ts";
import type { LinearPreflightCache } from "./preflight-cache.ts";

export type InputRecord = Record<string, unknown>;
export type Renderable = string | InputRecord;
export type FlagValue = string | boolean | (string | boolean)[] | undefined;

export interface ParsedFlags {
  [name: string]: FlagValue;
  positionals: string[];
}

/** Narrow an untrusted protocol value to a record without inventing its fields. */
export function isRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): InputRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function asArrayOfUnknown(value: unknown): unknown[] | undefined {
  return isUnknownArray(value) ? value : undefined;
}
export interface ParseFlagOptions {
  array?: string[];
  boolean?: string[];
  example?: string;
}

export interface McpClientLike {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: InputRecord): Promise<McpResult>;
  finishAuth?(code: string): Promise<void>;
  logoutAuth?(): Promise<{ removed: boolean; tokenConfigured: boolean }>;
  close?(): Promise<void>;
}

/** Advertised MCP operation metadata; schemas are consumed only by the closed resource adapter. */
export interface McpTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpResult {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface Runtime {
  stdin?: Readable;
  connection?: ManagedConnection;
  preflightCache?: LinearPreflightCache;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<Writable, "write">;
  client: McpClientLike;
  mcpUrl: string;
  binPath?: string;
  searchClient?: NativeSearchClient;
  storageClient?: StorageClient;
}

export interface MainContext {
  stdin?: Readable;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<Writable, "write">;
  client?: McpClientLike;
}
