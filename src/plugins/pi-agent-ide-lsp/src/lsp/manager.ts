import { readdir } from "node:fs/promises";
import path from "node:path";

import { URI } from "vscode-uri";

import { LspClient } from "./client.js";
import { toDiagnostic } from "./diagnostics.js";
import { type LspDiagnostic, type ResolvedServer } from "./types.js";

import type { LspServerRegistry } from "./registry.js";
import type { Diagnostic } from "pi-agent-ide/api/toolchain";

/** A workspace-scoped published report; an omitted version leaves freshness unverified. */
export interface LspPushDiagnosticsEvent {
  cwd: string;
  serverId: string;
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}

type PushHandler = (event: LspPushDiagnosticsEvent) => void;

/**
 * LspManager — server lifecycle, connection pooling, idle timeout.
 *
 * The process-stable instance is reconfigured for each Pi session so registered
 * compiler, formatter, and linter adapters keep a valid manager reference.
 */
export class LspManager {
  /**
    Active clients keyed by serverId.
    */
  private readonly _clients = new Map<string, LspClient>();
  private readonly _clientStarts = new Map<string, Promise<LspClient>>();
  /**
    Track already-opened URIs to avoid duplicate didOpen in formatter.
    */
  private readonly _openDocs = new Set<string>();
  private readonly _pushUnsubscribers = new Map<string, () => void>();
  private readonly _pushHandlers = new Set<PushHandler>();
  private readonly _pushFingerprints = new Map<string, string>();
  private _disposed = false;

  private static _instance: LspManager | null = null;

  private constructor(private _registry: LspServerRegistry) {}

  static getInstance(): LspManager {
    if (!LspManager._instance) {
      throw new Error("[lsp] LspManager not initialized");
    }

    return LspManager._instance;
  }

  static getInstanceOrNull(): LspManager | null {
    return LspManager._instance;
  }

  static init(registry: LspServerRegistry): LspManager {
    const current = LspManager._instance;

    if (current?._disposed) {
      current._registry = registry;
      current._disposed = false;
      return current;
    }

    LspManager._instance = new LspManager(registry);
    return LspManager._instance;
  }

  static async resetForTest(): Promise<void> {
    if (!LspManager._instance) {
      return;
    }

    await LspManager._instance.shutdownAll();
    LspManager._instance = null;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  get clientCount(): number {
    return this._clients.size;
  }

  /** Subscribe to full published reports, including clearing updates from pull-capable servers. */
  onPushDiagnostics(handler: PushHandler): () => void {
    this._pushHandlers.add(handler);
    return () => this._pushHandlers.delete(handler);
  }

  /**
   * Get or start the LSP client for a file extension.
   *
   * Resolves the extension through the registry, picks the first server
   * that has the requested capability, spawns it if needed, and returns
   * the ready client. Returns null if no LSP server is configured for
   * this extension or capability.
   */
  async getOrStart(
    extension: string,
    cwd: string,
    capability: "diagnostics" | "symbols",
  ): Promise<LspClient | null> {
    if (this._disposed) {
      return null;
    }

    const resolved = this._registry.resolve(extension);
    const match =
      capability === "symbols"
        ? resolved[0]
        : resolved.find((s) => s.config.capabilities.includes(capability));

    if (!match) {
      return null;
    }

    const rootUri = URI.file(cwd).toString();
    const clientKey = `${match.serverId}:${rootUri}`;
    const pendingClient = this._clientStarts.get(clientKey);

    if (pendingClient) {
      return pendingClient;
    }

    const client = this._clients.get(clientKey);

    if (client?.ready) {
      return client;
    }

    const clientStart = this._startClient(clientKey, rootUri, match, client);
    this._clientStarts.set(clientKey, clientStart);

    try {
      return await clientStart;
    } finally {
      if (this._clientStarts.get(clientKey) === clientStart) {
        this._clientStarts.delete(clientKey);
      }
    }
  }

  private async _startClient(
    clientKey: string,
    rootUri: string,
    match: ResolvedServer,
    client: LspClient | undefined,
  ): Promise<LspClient> {
    const startingClient =
      client ??
      new LspClient({
        serverId: match.serverId,
        rootUri,
        command: match.config.command,
        ...(match.config.env && { env: match.config.env }),
        ...(match.config.initializationOptions && {
          initOptions: match.config.initializationOptions,
        }),
        ...(match.config.settings && { settings: match.config.settings }),
        ...(match.config.timeoutMs && { timeoutMs: match.config.timeoutMs }),
      });

    try {
      if (client) {
        await client.restart();
      } else {
        await startingClient.start();
      }
    } catch (error) {
      await startingClient.shutdown().catch(() => void 0);
      throw error;
    }

    if (this._disposed) {
      await startingClient.shutdown();
      throw new Error(`[lsp] ${match.serverId}: manager disposed during startup`);
    }

    this._clients.set(clientKey, startingClient);
    this._subscribeToPushDiagnostics(clientKey, startingClient);
    return startingClient;
  }

  /**
   * Start the native LSP clients that can search the current workspace.
   *
   * Workspace symbols are requested per language server, so a search with
   * no file extension must query every configured language family.
   */
  async getWorkspaceClients(cwd: string, capability: "symbols" = "symbols"): Promise<LspClient[]> {
    const clients = new Set<LspClient>();

    for (const extension of this._registry.knownExtensions) {
      try {
        const client = await this.getOrStart(extension, cwd, capability);

        if (client) {
          clients.add(client);
        }
      } catch {
        // A workspace may list servers that are not installed locally.
      }
    }

    return [...clients];
  }

  /**
    Open one representative file for each configured language family.
    */
  async prepareWorkspaceSymbols(cwd: string): Promise<LspClient[]> {
    const clients = await this.getWorkspaceClients(cwd);
    const remainingExtensions = new Set(this._registry.knownExtensions);
    const ignoredDirectories = new Set([".git", ".cache", "node_modules", "dist", "build"]);

    const visit = async (directory: string): Promise<void> => {
      if (remainingExtensions.size === 0) {
        return;
      }

      let entries;

      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (remainingExtensions.size === 0) {
          return;
        }

        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) {
            await visit(path.join(directory, entry.name));
          }

          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = path.extname(entry.name).toLowerCase();

        if (!remainingExtensions.has(extension)) {
          continue;
        }

        const filePath = path.join(directory, entry.name);
        const opened = await this.openFile(filePath, cwd, "symbols").catch(() => null);

        if (opened) {
          remainingExtensions.delete(extension);
        }
      }
    };

    await visit(cwd);
    return clients;
  }

  /**
    Check if there's any LSP server configured for this file extension.
    */
  hasServerFor(extension: string): boolean {
    return this._registry.resolve(extension).length > 0;
  }

  /**
    Resolve a file extension to its canonical LSP languageId.
    */
  languageId(extension: string): string {
    return this._registry.languageId(extension);
  }

  /**
    True if this URI was already opened via openFile.
    */
  isOpen(uri: string): boolean {
    return this._openDocs.has(uri);
  }

  // ── document helpers ───────────────────────────────────────────────

  /**
   * Open a document in the appropriate LSP server and return the client.
   * Returns null if no server handles this file.
   */
  async openFile(
    filePath: string,
    cwd: string,
    capability: "diagnostics" | "symbols" = "diagnostics",
  ): Promise<{ client: LspClient; uri: string; languageId: string } | null> {
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    const absolutePath = path.resolve(cwd, filePath);
    const client = await this.getOrStart(extension, cwd, capability);

    if (!client) {
      return null;
    }

    const uri = client.toUri(absolutePath);
    const resolved = this._registry.resolve(extension);
    const languageId = resolved[0]?.languageId ?? "plaintext";

    // Read file content for didOpen
    // We use a minimal open — the server gets the text from disk next request
    try {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(absolutePath, "utf8");
      client.openDocument(uri, text, languageId);
      this._openDocs.add(uri);
    } catch {
      // File doesn't exist yet — server will pick it up on next change
    }

    return { client, uri, languageId };
  }

  private _subscribeToPushDiagnostics(clientKey: string, client: LspClient): void {
    if (this._pushUnsubscribers.has(clientKey)) {
      return;
    }

    const unsubscribe = client.onNotification("textDocument/publishDiagnostics", (parameters) => {
      const notification = parsePushNotification(parameters);

      if (!notification || client.hasActiveDiagnosticRequest(notification.uri)) {
        return;
      }

      const currentVersion = client.documentVersion(notification.uri);

      if (
        notification.version !== undefined &&
        currentVersion !== undefined &&
        notification.version < currentVersion
      ) {
        return;
      }

      const key = `${clientKey}:${notification.uri}`;
      const diagnostics = notification.diagnostics.map(toDiagnostic);
      const fingerprint = JSON.stringify([notification.version, currentVersion, diagnostics]);

      if (this._pushFingerprints.get(key) === fingerprint) {
        return;
      }

      this._pushFingerprints.set(key, fingerprint);
      const event: LspPushDiagnosticsEvent = {
        cwd: URI.parse(client.rootUri).fsPath,
        serverId: client.serverId,
        uri: notification.uri,
        diagnostics,
        ...(notification.version !== undefined && { version: notification.version }),
      };

      for (const handler of this._pushHandlers) {
        handler(event);
      }
    });
    this._pushUnsubscribers.set(clientKey, unsubscribe);
  }
  // ── cleanup ────────────────────────────────────────────────────────

  async shutdownAll(): Promise<void> {
    this._disposed = true;
    await Promise.allSettled(this._clientStarts.values());

    const clients = [...this._clients.values()];
    await Promise.all(clients.map((c) => c.shutdown()));

    for (const unsubscribe of this._pushUnsubscribers.values()) {
      unsubscribe();
    }

    this._pushUnsubscribers.clear();
    this._clientStarts.clear();
    this._pushFingerprints.clear();
    this._pushHandlers.clear();
    this._clients.clear();
  }

  dispose(): void {
    void this.shutdownAll();
  }
}

function parsePushNotification(parameters: unknown):
  | {
      uri: string;
      version?: number;
      diagnostics: LspDiagnostic[];
    }
  | undefined {
  if (parameters === null || typeof parameters !== "object") {
    return undefined;
  }

  const value = parameters as { uri?: unknown; version?: unknown; diagnostics?: unknown };

  if (typeof value.uri !== "string" || !Array.isArray(value.diagnostics)) {
    return undefined;
  }

  return {
    uri: value.uri,
    diagnostics: value.diagnostics as LspDiagnostic[],
    ...(typeof value.version === "number" && { version: value.version }),
  };
}
