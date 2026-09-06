/**
 * LSP layer types — server config and protocol features.
 *
 * Owned by the LSP extension. Not tied to any specific LSP server implementation.
 */

import type { ToolConfigLayer } from "pi-agent-ide/api/tool-config";

// ── LSP protocol primitives ───────────────────────────────────────────

/**
LSP DiagnosticSeverity: 1=Error, 2=Warning, 3=Information, 4=Hint.
*/
export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface LspPosition {
  /**
    0-based line.
    */
  line: number;
  /**
    0-based character (UTF-16 code units).
    */
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

// ── Server configuration (data-driven) ─────────────────────────────────

export interface LanguageEntry {
  extensions: string[];
}

export type ServerCapability = "diagnostics";

export interface ServerConfig {
  command: string[];
  transport?: "stdio";
  rootMarkers: string[];
  languages: Record<string, LanguageEntry>;
  capabilities: ServerCapability[];
  env?: Record<string, string>;
  /**
    Passed as initializationOptions in the initialize request.
    */
  initializationOptions?: Record<string, unknown>;
  /**
    Sent through workspace/didChangeConfiguration after initialization.
    */
  settings?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LspServersConfig {
  version: 1;
  servers: Record<string, ServerConfig>;
}

// ── Resolved server info (registry output) ─────────────────────────────

export interface ResolvedServer {
  /** Server key from lsp-servers.json (e.g. "gopls"). */
  serverId: string;
  config: ServerConfig;
  /** LanguageId this extension maps to (e.g. "go"). */
  languageId: string;
  /** Configuration layer that supplied this server. */
  layer: ToolConfigLayer;
  /** JSON file that supplied this server. */
  sourcePath: string;
}

// ── Client state ───────────────────────────────────────────────────────

export interface LspClientState {
  serverId: string;
  command: string[];
  /**
    Process PID.
    */
  pid: number;
  /**
    True when initialized and ready.
    */
  ready: boolean;
  /**
    Timestamp of last request (for idle timeout).
    */
  lastActivity: number;
}
