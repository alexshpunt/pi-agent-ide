import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { URI } from "vscode-uri";

import { LspClient } from "./client.js";
import { SharedStartup, waitWithSignal } from "./abort.js";
import { documentUri } from "./document-uri.js";
import type { LspWorkspaceOwner } from "./workspace-owner.js";
import { prepareProjectQuery } from "./project.js";

import { resolveInitializationOptions } from "./initialization-options.js";
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
  private readonly _clientStarts = new Map<string, SharedStartup<LspClient>>();
  /**
    Track already-opened URIs to avoid duplicate didOpen in formatter.
    */
  private readonly _openDocs = new Set<string>();
  private readonly _pushUnsubscribers = new Map<string, () => void>();
  private readonly _pushHandlers = new Set<PushHandler>();
  private readonly _pushFingerprints = new Map<string, string>();
  private _disposed = false;

  private static _instance: LspManager | null = null;

  private constructor(
    private _registry: LspServerRegistry,
    private _owner?: LspWorkspaceOwner,
  ) {}

  static getInstance(): LspManager {
    if (!LspManager._instance) {
      throw new Error("[lsp] LspManager not initialized");
    }

    return LspManager._instance;
  }

  static getInstanceOrNull(): LspManager | null {
    return LspManager._instance;
  }

  static init(registry: LspServerRegistry, owner?: LspWorkspaceOwner): LspManager {
    const current = LspManager._instance;

    if (current?._disposed) {
      current._registry = registry;
      current._owner = owner;
      current._disposed = false;
      return current;
    }

    LspManager._instance = new LspManager(registry, owner);
    return LspManager._instance;
  }

  static async resetForTest(): Promise<void> {
    if (!LspManager._instance) {
      return;
    }

    await LspManager._instance.shutdownAll();
    LspManager._instance = null;
  }

  private requireOwner(): LspWorkspaceOwner {
    if (!this._owner)
      throw Object.assign(new Error("No language server workspace owner"), {
        code: "UNSUPPORTED_SOURCE",
      });
    return this._owner;
  }
  // ── lifecycle ──────────────────────────────────────────────────────

  /** Configured workspace identity used for owner-scoped navigation. */
  get workspaceRoot(): string {
    return this._registry.projectRoot;
  }
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
    signal?: AbortSignal,
  ): Promise<LspClient | null> {
    signal?.throwIfAborted();
    if (this._disposed) return null;
    const remote = cwd.startsWith("ssh://");
    const owner = remote ? this.requireOwner() : undefined;
    const resolved = owner
      ? await this._registry.resolveOwned(extension, (source) => owner.exists(source, signal))
      : this._registry.resolve(extension);
    signal?.throwIfAborted();
    // Marker I/O can finish after shutdown has started.
    // eslint-disable-next-line typescript/no-unnecessary-condition
    if (this._disposed) return null;
    const match =
      capability === "symbols"
        ? resolved[0]
        : resolved.find((s) => s.config.capabilities.includes(capability));
    if (!match) return null;
    const rootUri = remote ? cwd : URI.file(cwd).toString();
    const clientKey = `${match.serverId}:${rootUri}`;
    const pending = this._clientStarts.get(clientKey);
    if (pending) {
      if (pending.controller.signal.aborted) {
        await waitWithSignal(
          pending.promise.catch(() => undefined),
          signal,
        );
        return this.getOrStart(extension, cwd, capability, signal);
      }
      return pending.wait(signal);
    }
    const client = this._clients.get(clientKey);
    if (client?.ready) return client;
    const startup = new SharedStartup((startupSignal) =>
      this._startClient(clientKey, rootUri, match, client, startupSignal),
    );
    this._clientStarts.set(clientKey, startup);
    const settled = () => {
      if (this._clientStarts.get(clientKey) === startup) this._clientStarts.delete(clientKey);
    };
    void startup.promise.then(settled, settled);
    return startup.wait(signal);
  }

  private async _startClient(
    clientKey: string,
    rootUri: string,
    match: ResolvedServer,
    client: LspClient | undefined,
    signal: AbortSignal,
  ): Promise<LspClient> {
    const startingClient =
      client ??
      new LspClient({
        serverId: match.serverId,
        rootUri,
        command: match.config.command,
        ...(rootUri.startsWith("ssh://") &&
          this._owner && {
            ownerTransport: this._owner.transport(rootUri),
          }),
        ...(match.config.env && { env: match.config.env }),
        ...(match.config.initializationOptions && {
          initOptions: resolveInitializationOptions(
            match.config.initializationOptions,
            rootUri.startsWith("ssh://")
              ? decodeURIComponent(new URL(rootUri).pathname)
              : URI.parse(rootUri).fsPath,
          ),
        }),
        ...(match.config.settings && { settings: match.config.settings }),
        ...(match.config.timeoutMs && { timeoutMs: match.config.timeoutMs }),
      });

    try {
      if (client) {
        await client.restart(signal);
      } else {
        await startingClient.start(signal);
      }
      signal.throwIfAborted();
    } catch (error) {
      try {
        await startingClient.shutdown();
      } catch (cleanupError) {
        if (cleanupError !== error) {
          throw new AggregateError(
            [error, cleanupError],
            "Language server startup and cleanup failed",
            {
              cause: cleanupError,
            },
          );
        }
      }
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

  /** Start symbol servers only for language families with files in this workspace. */
  async getWorkspaceClients(
    cwd: string,
    capability: "symbols" = "symbols",
    scope = cwd,
    acceptsFile: (source: string) => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<LspClient[]> {
    signal?.throwIfAborted();
    if (cwd.startsWith("ssh://")) {
      const owner = this._owner;
      if (!owner)
        throw Object.assign(new Error("No language server workspace owner"), {
          code: "UNSUPPORTED_SOURCE",
        });
      const clients = new Set<LspClient>();
      const remaining = new Set(this._registry.knownExtensions);
      const ignored = new Set([".git", ".cache", "node_modules", "dist", "build"]);
      const visit = async (source: string): Promise<void> => {
        signal?.throwIfAborted();
        if (remaining.size === 0) return;
        for (const entry of await owner.entries(source, signal)) {
          signal?.throwIfAborted();
          const uri = documentUri(entry.name, `${source}/`);
          if (entry.kind === "directory") {
            if (!ignored.has(entry.name)) await visit(uri);
          } else if (entry.kind === "file") {
            const extension = path.posix.extname(entry.name).toLowerCase();
            if (!remaining.has(extension) || !acceptsFile(uri)) continue;
            const opened = await this.openFile(uri, cwd, capability, signal);
            if (opened) {
              clients.add(opened.client);
              remaining.delete(extension);
            }
          }
        }
      };
      const selected = documentUri(scope, cwd);
      if (await owner.isFile(selected, signal)) {
        if (!acceptsFile(selected)) return [];
        const opened = await this.openFile(selected, cwd, capability, signal);
        return opened ? [opened.client] : [];
      }
      await visit(selected);
      return [...clients];
    }
    const clients = new Set<LspClient>();
    const remainingExtensions = new Set(this._registry.knownExtensions);
    const ignoredDirectories = new Set([".git", ".cache", "node_modules", "dist", "build"]);

    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
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
        signal?.throwIfAborted();
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
        if (!acceptsFile(filePath)) continue;
        const opened = await this.openFile(filePath, cwd, capability, signal);

        if (opened) {
          remainingExtensions.delete(extension);
          if (opened.client.hasWorkspaceSymbolCapability) {
            await prepareProjectQuery(opened.client, filePath);
            clients.add(opened.client);
          }
        }
      }
    };

    const selected = path.resolve(cwd, scope);
    if ((await stat(selected)).isFile()) {
      if (!acceptsFile(selected)) return [];
      const opened = await this.openFile(selected, cwd, capability, signal);
      if (opened === null || !opened.client.hasWorkspaceSymbolCapability) return [];
      await prepareProjectQuery(opened.client, selected);
      return [opened.client];
    }
    await visit(selected);
    signal?.throwIfAborted();
    return [...clients];
  }

  /** Open matching source files before querying workspace symbols; excluded files start no server. */
  async prepareWorkspaceSymbols(
    cwd: string,
    scope = cwd,
    acceptsFile?: (source: string) => boolean,
    signal?: AbortSignal,
  ): Promise<LspClient[]> {
    return this.getWorkspaceClients(cwd, "symbols", scope, acceptsFile, signal);
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

  /** Publish saved text only to already-open documents; never start a server or probe a file. */
  syncEditedSource(source: string, content: string): void {
    for (const client of this._clients.values()) {
      if (!client.ready) continue;
      const uri = client.toUri(source);
      if (client.documentContent(uri) === undefined) continue;
      const languageId = this.languageId(path.extname(decodeURIComponent(new URL(uri).pathname)));
      client.syncDocument(uri, content, languageId, true);
    }
  }
  /** Capture a rename participant revision without comparing clocks across machines. */
  async readSourceSnapshot(
    source: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; version: string }> {
    signal?.throwIfAborted();
    if (source.startsWith("ssh://")) return this.requireOwner().readSnapshot(source, signal);
    if (source.includes("://"))
      throw Object.assign(new Error("Unsupported rename source"), { code: "UNSUPPORTED_SOURCE" });
    const identity = (info: Awaited<ReturnType<typeof stat>>) =>
      `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const before = identity(await stat(source));
    const content = await this.readSourceText(source, signal);
    if (before !== identity(await stat(source)))
      throw new Error("A rename source changed while reading it. No edits applied.");
    return {
      content,
      version: createHash("sha256").update(before).update("\0").update(content).digest("hex"),
    };
  }
  /** Preserve original bytes for code-view size and binary checks. */
  async readSourceBytes(source: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (source.startsWith("ssh://")) return this.requireOwner().readBytes(source, signal);
    if (source.includes("://"))
      throw Object.assign(new Error("Unsupported declaration source"), {
        code: "UNSUPPORTED_SOURCE",
      });
    const { readFile } = await import("node:fs/promises");
    return readFile(source, { signal });
  }
  /** Read declaration text from its owner, without routing a remote URI to local fs. */
  async readSourceText(source: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (source.startsWith("ssh://")) return this.requireOwner().readText(source, signal);
    if (source.includes("://"))
      throw Object.assign(new Error("Unsupported declaration source"), {
        code: "UNSUPPORTED_SOURCE",
      });
    const { readFile } = await import("node:fs/promises");
    return readFile(source, { encoding: "utf8", signal });
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
    signal?: AbortSignal,
  ): Promise<{ client: LspClient; uri: string; languageId: string } | null> {
    signal?.throwIfAborted();
    if (filePath.startsWith("ssh://") && !cwd.startsWith("ssh://")) {
      if (!this._registry.projectRoot.startsWith("ssh://"))
        throw Object.assign(new Error("Remote document has no workspace owner"), {
          code: "UNSUPPORTED_SOURCE",
        });
      cwd = this._registry.projectRoot;
    }
    const remote = cwd.startsWith("ssh://");
    const absolutePath = remote ? documentUri(filePath, cwd) : path.resolve(cwd, filePath);
    const client = await this.getOrStart(absolutePath, cwd, capability, signal);

    if (!client) {
      return null;
    }

    const uri = client.toUri(absolutePath);
    const owner = remote ? this.requireOwner() : undefined;
    const resolved = owner
      ? await this._registry.resolveOwned(absolutePath, (source) => owner.exists(source, signal))
      : this._registry.resolve(absolutePath);
    const languageId = resolved[0]?.languageId ?? "plaintext";

    if (owner) {
      const text = await owner.readText(uri, signal);
      signal?.throwIfAborted();
      client.syncDocument(uri, text, languageId);
      this._openDocs.add(uri);
      return { client, uri, languageId };
    }
    // Read file content for didOpen
    // We use a minimal open — the server gets the text from disk next request
    try {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(absolutePath, { encoding: "utf8", signal });
      signal?.throwIfAborted();
      client.syncDocument(uri, text, languageId);
      this._openDocs.add(uri);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // Files created later will be synchronized by the next change.
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
        cwd: client.rootUri.startsWith("ssh://")
          ? client.rootUri
          : URI.parse(client.rootUri).fsPath,
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
    const pending = [...this._clientStarts.values()];
    for (const startup of pending)
      startup.controller.abort(new Error("Language server manager stopped"));
    const starts = await Promise.allSettled(pending.map((startup) => startup.promise));
    const failures: unknown[] = [];
    for (const [index, result] of starts.entries()) {
      if (
        result.status === "rejected" &&
        result.reason !== pending[index]?.controller.signal.reason
      ) {
        failures.push(result.reason);
      }
    }

    const clients = [...this._clients.values()];
    const results = await Promise.allSettled(clients.map((client) => client.shutdown()));

    for (const unsubscribe of this._pushUnsubscribers.values()) {
      unsubscribe();
    }

    this._pushUnsubscribers.clear();
    this._clientStarts.clear();
    this._pushFingerprints.clear();
    this._pushHandlers.clear();
    this._clients.clear();

    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Language server cleanup failed");
  }

  /** Await all workspace cleanup and report failed owned stops. */
  dispose(): Promise<void> {
    return this.shutdownAll();
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
