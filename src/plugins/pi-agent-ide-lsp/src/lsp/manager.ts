import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readUnchanged, type FileGenerationReader } from "pi-agent-resource";
import { URI } from "vscode-uri";

import { LspClient } from "./client.ts";
import type { LspSharedServers } from "./shared-servers.ts";
import { SharedStartup, waitWithSignal } from "./abort.ts";
import { documentUri } from "./document-uri.ts";
import { sourceChanged } from "./source-changes.ts";
import type { LspWorkspaceOwner } from "./workspace-owner.ts";
import { hasTypeScriptProjectQueries, loadQueryProject } from "./project.ts";
import { retainForCurrentOperation } from "./document-leases.ts";
import { localFilesContaining } from "./files-containing.ts";

import {
  resolveInitializationOptions,
  usesWorkspaceVuePlugin,
  vuePluginDirectory,
} from "./initialization-options.ts";
import { toDiagnostic } from "./diagnostics.ts";
import { type LspDiagnostic, type ResolvedServer } from "./types.ts";

import type { LspServerRegistry } from "./registry.ts";
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

/** Text of a source file, given as an absolute path or, for a remote workspace, its URI. */
export type SourceTextReader = (source: string) => Promise<string>;

export interface LspManagerOptions {
  /** Stop a server after this long without requests or open operations. Omitted: never. */
  readonly idleTimeoutMs?: number;
  /** Share local servers with other Pi sessions on this machine. Omitted: every server is own. */
  readonly sharedServers?: LspSharedServers;
  /** Reads file metadata for source snapshots; tests supply the timestamps of a coarse clock. */
  readonly fileGeneration?: FileGenerationReader;
}

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
  private readonly _pushUnsubscribers = new Map<string, () => void>();
  private readonly _pushHandlers = new Set<PushHandler>();
  private readonly _pushFingerprints = new Map<string, string>();
  private _disposed = false;

  private static _instance: LspManager | null = null;

  private constructor(
    private _registry: LspServerRegistry,
    private _owner?: LspWorkspaceOwner,
    private _options: LspManagerOptions = {},
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

  static init(
    registry: LspServerRegistry,
    owner?: LspWorkspaceOwner,
    options: LspManagerOptions = {},
  ): LspManager {
    const current = LspManager._instance;

    if (current?._disposed) {
      current._registry = registry;
      current._owner = owner;
      current._options = options;
      current._disposed = false;
      return current;
    }

    LspManager._instance = new LspManager(registry, owner, options);
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
    const options = match.config.initializationOptions;
    const project = remote
      ? decodeURIComponent(new URL(rootUri).pathname)
      : URI.parse(rootUri).fsPath;
    const vueRoot =
      options &&
      match.serverId === "vue-typescript-language-server" &&
      usesWorkspaceVuePlugin(options)
        ? await vuePluginDirectory(
            remote
              ? decodeURIComponent(new URL(documentUri(extension, rootUri)).pathname)
              : path.resolve(cwd, extension),
            project,
            remote ? path.posix : path,
            owner
              ? (file) => owner.exists(documentUri(file, rootUri), signal)
              : async (file) => (await stat(file).catch(() => undefined))?.isFile() === true,
          )
        : project;
    signal?.throwIfAborted();
    const clientKey = JSON.stringify([match.serverId, rootUri, vueRoot]);
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
    if (client?.ready) {
      client.touch();
      return client;
    }
    const startup = new SharedStartup((startupSignal) =>
      this._startClient(
        clientKey,
        rootUri,
        match,
        client,
        options && resolveInitializationOptions(options, project, vueRoot),
        startupSignal,
      ),
    );
    this._clientStarts.set(clientKey, startup);
    const settled = () => {
      if (this._clientStarts.get(clientKey) === startup) this._clientStarts.delete(clientKey);
    };
    void startup.promise.then(settled, settled);
    const started = await startup.wait(signal);
    started.touch();
    return started;
  }

  /** Stop a server with no requests or open operations; the next request starts a new one. */
  private _stopIdleClient(clientKey: string, client: LspClient): void {
    if (this._clients.get(clientKey) === client) {
      this._clients.delete(clientKey);
      this._pushUnsubscribers.get(clientKey)?.();
      this._pushUnsubscribers.delete(clientKey);
      for (const key of this._pushFingerprints.keys())
        if (key.startsWith(`${clientKey}:`)) this._pushFingerprints.delete(key);
    }
    void client.shutdown().catch((error: unknown) => {
      console.error(`[lsp] ${client.serverId}: idle shutdown failed:`, error);
    });
  }

  private async _startClient(
    clientKey: string,
    rootUri: string,
    match: ResolvedServer,
    client: LspClient | undefined,
    initOptions: Record<string, unknown> | undefined,
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
        ...(!rootUri.startsWith("ssh://") &&
          this._options.sharedServers && { sharedServers: this._options.sharedServers }),
        ...(match.config.env && { env: match.config.env }),
        ...(initOptions && { initOptions }),
        ...(match.config.settings && { settings: match.config.settings }),
        ...(match.config.timeoutMs && { timeoutMs: match.config.timeoutMs }),
        ...(this._options.idleTimeoutMs !== undefined && {
          idleTimeoutMs: this._options.idleTimeoutMs,
          onIdle: () => this._stopIdleClient(clientKey, startingClient),
        }),
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

  /** Inspect source kind through its workspace owner without reading content or starting a server. */
  async isSourceFile(source: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (cwd.startsWith("ssh://")) {
      if (this._owner === undefined) throw new Error("No language server workspace owner");
      return this._owner.isFile(documentUri(source, cwd), signal);
    }
    const file = await stat(path.resolve(cwd, source));
    signal?.throwIfAborted();
    return file.isFile();
  }

  /**
   * Sources under the workspace root of `client` whose text has `word` as a whole word, among
   * files of the given languages. Undefined when the workspace owner has no text search.
   */
  async filesContaining(
    client: LspClient,
    word: string,
    languageIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined> {
    signal?.throwIfAborted();
    const extensions = [...this._registry.knownExtensions].filter((extension) =>
      languageIds.has(this._registry.languageId(extension)),
    );
    if (extensions.length === 0) return [];
    if (client.rootUri.startsWith("ssh://"))
      return this.requireOwner().filesContaining?.(client.rootUri, word, extensions, signal);
    return localFilesContaining(URI.parse(client.rootUri).fsPath, word, extensions, signal);
  }
  /**
   * Sources under `root` of the workspace `cwd` whose text has `word` as a whole word, among files
   * with a configured language server. A file `root` is its own only candidate. Undefined when the
   * workspace owner has no text search.
   */
  async filesContainingInScope(
    cwd: string,
    root: string,
    word: string,
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined> {
    signal?.throwIfAborted();
    const remote = cwd.startsWith("ssh://");
    const selected = remote ? documentUri(root, cwd) : path.resolve(cwd, root);
    if (await this.isSourceFile(selected, cwd, signal)) return [selected];
    const extensions = [...this._registry.knownExtensions];
    if (extensions.length === 0) return [];
    return remote
      ? this.requireOwner().filesContaining?.(selected, word, extensions, signal)
      : localFilesContaining(selected, word, extensions, signal);
  }

  /**
   * Seed native workspace indexes. Most servers need one document per language extension;
   * TypeScript needs one for each project represented in the scope.
   */
  async prepareWorkspaceSymbols(
    cwd: string,
    scope = cwd,
    acceptsFile: (source: string) => boolean = () => true,
    signal?: AbortSignal,
    readText?: SourceTextReader,
  ): Promise<LspClient[]> {
    signal?.throwIfAborted();
    const remote = cwd.startsWith("ssh://");
    const owner = remote ? this.requireOwner() : undefined;
    const remaining = new Set(this._registry.knownExtensions);
    const projectFiles = new Map<LspClient, Set<string>>();
    const typeScriptByExtension = new Map<string, LspClient>();
    const clients = new Set<LspClient>();
    const ignored = new Set([".git", ".cache", "node_modules", "dist", "build"]);
    const extensionOf = (source: string) =>
      (remote
        ? path.posix.extname(decodeURIComponent(new URL(source).pathname))
        : path.extname(source)
      ).toLowerCase();

    const seed = async (source: string, extension: string) => {
      if (!acceptsFile(source)) return;
      const known = typeScriptByExtension.get(extension);
      if (known && projectFiles.get(known)?.has(known.serverDocumentPath(source))) return;
      const opened = await this.openFile(source, cwd, "symbols", signal, readText);
      if (opened === null) return;
      const { client, uri } = opened;
      if (client.hasWorkspaceSymbolCapability) {
        clients.add(client);
        if (hasTypeScriptProjectQueries(client)) {
          const covered = projectFiles.get(client) ?? new Set<string>();
          typeScriptByExtension.set(extension, client);
          projectFiles.set(client, covered);
          for (const file of await loadQueryProject(client, uri, signal)) covered.add(file);
          return;
        }
      }
      remaining.delete(extension);
    };
    const localEntries = async (directory: string) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
    };
    const visit = async (directory: string): Promise<void> => {
      if (remaining.size === 0) return;
      const entries = owner
        ? await owner.entries(directory, signal)
        : await localEntries(directory);
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (remaining.size === 0) return;
        const source = remote
          ? documentUri(entry.name, `${directory}/`)
          : path.join(directory, entry.name);
        if (entry.kind === "directory") {
          if (!ignored.has(entry.name)) await visit(source);
        } else if (entry.kind === "file") {
          const extension = extensionOf(source);
          if (remaining.has(extension)) await seed(source, extension);
        }
      }
    };

    const selected = remote ? documentUri(scope, cwd) : path.resolve(cwd, scope);
    if (await this.isSourceFile(selected, cwd, signal)) await seed(selected, extensionOf(selected));
    else await visit(selected);
    signal?.throwIfAborted();
    return [...clients];
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
    const read = await readUnchanged(
      source,
      () => this.readSourceText(source, signal),
      (first, second) => first === second,
      this._options.fileGeneration,
    );
    if (read === undefined)
      throw sourceChanged("A rename source changed while reading it. No edits applied.");
    return {
      content: read.value,
      version: createHash("sha256")
        .update(read.stamp)
        .update("\0")
        .update(read.value)
        .digest("hex"),
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
   * `readText` supplies the text to publish, such as one a caller already read of the file;
   * by default the file is read from disk or, in a remote workspace, from its owner.
   */
  async openFile(
    filePath: string,
    cwd: string,
    capability: "diagnostics" | "symbols" = "diagnostics",
    signal?: AbortSignal,
    readText?: SourceTextReader,
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

    const owner = remote ? this.requireOwner() : undefined;
    const resolved = owner
      ? await this._registry.resolveOwned(absolutePath, (source) => owner.exists(source, signal))
      : this._registry.resolve(absolutePath);
    const languageId =
      resolved.find((match) => match.serverId === client.serverId)?.languageId ??
      resolved[0]?.languageId ??
      "plaintext";
    return this.openClientFile(client, absolutePath, languageId, signal, readText);
  }

  /** Publish a declaration in the same project that discovered it. */
  async openClientFile(
    client: LspClient,
    source: string,
    languageId: string,
    signal?: AbortSignal,
    readText?: SourceTextReader,
  ): Promise<{ client: LspClient; uri: string; languageId: string }> {
    signal?.throwIfAborted();
    const uri = client.toUri(source);
    retainForCurrentOperation(client, uri);
    const owner = uri.startsWith("ssh://") ? this.requireOwner() : undefined;

    if (owner) {
      const text = readText ? await readText(source) : await owner.readText(uri, signal);
      signal?.throwIfAborted();
      client.syncDocument(uri, text, languageId);
      await client.waitUntilLoaded(signal);
      return { client, uri, languageId };
    }
    // Read file content for didOpen
    // We use a minimal open — the server gets the text from disk next request
    try {
      const { readFile } = await import("node:fs/promises");
      const text = readText
        ? await readText(source)
        : await readFile(source, { encoding: "utf8", signal });
      signal?.throwIfAborted();
      client.syncDocument(uri, text, languageId);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // Files created later will be synchronized by the next change.
    }
    // A server that is still loading the project answers with incomplete or empty results.
    await client.waitUntilLoaded(signal);

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
