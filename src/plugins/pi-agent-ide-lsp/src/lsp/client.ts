import { requiredValue } from "pi-agent-invariant";
import { type ChildProcess } from "node:child_process";

import path from "node:path";

import spawnProcess from "cross-spawn";
import {
  configuredExecutableName,
  createConfiguredProcessEnvironment,
} from "pi-agent-ide/api/tool-config";
import {
  createMessageConnection,
  CancellationTokenSource,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
} from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";

import type { LspDiagnostic } from "./types.js";

import { LspFileWatchers, type LspFileWatcherSubscriptions } from "./file-watchers.js";
import { configurationItems } from "./server-request-handlers.mjs";
import {
  DEFAULT_SHARED_SERVER_LINGER_MS,
  type LspSharedServer,
  type LspSharedServers,
} from "./shared-servers.js";

import { TransportWriter } from "./transport-writer.js";
import { documentUri } from "./document-uri.js";
import { delayWithSignal, waitWithSignal } from "./abort.js";
import { mapLspUris, type LspOwnerTransport, type LspOwnedProcess } from "./owner-transport.js";

/** Latest push observation for an open document, without a completion guarantee. */
export interface LspDiagnosticPublication {
  readonly version?: number;
  readonly diagnostics: LspDiagnostic[];
}

/**
 * Generic LSP client — JSON-RPC over stdio.
 *
 * Language-agnostic. One instance per LSP server process.
 * Handles initialize → initialized → keep-alive → shutdown lifecycle.
 */
export class LspClient {
  private _process: ChildProcess | null = null;
  private _ownedProcess: LspOwnedProcess | null = null;
  private _ownedStartup: Promise<LspOwnedProcess> | undefined;
  private readonly _ownerTransport: LspOwnerTransport | undefined;
  private readonly _sharedServers: LspSharedServers | undefined;
  private _sharedServer: LspSharedServer | null = null;
  private _connection: MessageConnection | null = null;
  private _initialized = false;
  private _serverCapabilities: Record<string, unknown> | null = null;
  private _disposed = false;
  private _shutdownPromise: Promise<void> | undefined;

  private _crashed = false;

  private _stderr = "";

  private _fileWatchers: LspFileWatcherSubscriptions | undefined;
  private _fileWatcherCleanup: Promise<void> = Promise.resolve();
  private readonly _handlers = new Map<string, ((parameters: unknown) => void)[]>();
  private readonly _documentVersions = new Map<string, number>();

  private readonly _documentContents = new Map<string, string>();

  private readonly _diagnosticPublications = new Map<string, LspDiagnosticPublication>();
  private _diagnosticMode: "unknown" | "pull" | "push" = "unknown";
  /** Set once the server versions its pushes; its unversioned pushes then describe closed documents. */
  private _versionedDiagnostics = false;
  private readonly _activeDiagnosticRequests = new Set<string>();
  /** Operations that still use each open document; the last release closes it. */
  private readonly _documentLeases = new Map<string, number>();
  private _pendingRequests = 0;
  private _idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _idleTimeoutMs: number | undefined;
  private readonly _onIdle: (() => void) | undefined;

  readonly serverId: string;
  readonly rootUri: string;
  private readonly _command: string[];
  private readonly _args: string[];
  private readonly _env: Record<string, string>;
  private readonly _initOptions: Record<string, unknown> | undefined;
  private readonly _settings: Record<string, unknown> | undefined;
  private readonly _timeoutMs: number;

  constructor(parameters: {
    serverId: string;
    rootUri: string;
    command: string[];
    env?: Record<string, string>;
    initOptions?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    timeoutMs?: number;
    ownerTransport?: LspOwnerTransport;
    /** Share a local server with other Pi sessions; if that fails, start an own process. */
    sharedServers?: LspSharedServers;
    /** Without requests or open operations for this long, onIdle runs. Omitted: never idle. */
    idleTimeoutMs?: number;
    onIdle?: () => void;
  }) {
    this.serverId = parameters.serverId;
    this.rootUri = parameters.rootUri;
    this._command = parameters.command;
    this._args = parameters.command.slice(1);
    this._env = parameters.env ?? {};
    this._initOptions = parameters.initOptions;
    this._settings = parameters.settings;
    this._timeoutMs = parameters.timeoutMs ?? 30_000;
    this._ownerTransport = parameters.ownerTransport;
    this._sharedServers = parameters.sharedServers;
    this._idleTimeoutMs = parameters.idleTimeoutMs;
    this._onIdle = parameters.onIdle;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  get ready(): boolean {
    return this._initialized && !this._disposed;
  }

  get crashed(): boolean {
    return this._crashed;
  }

  get pid(): number | null {
    return this._process?.pid ?? this._sharedServer?.pid ?? null;
  }

  /** Whether this client reaches a server shared with other Pi sessions. */
  get shared(): boolean {
    return this._sharedServer !== null;
  }

  /** Remote process identity; pid remains null for these servers. */
  get remote(): LspOwnedProcess["remote"] | undefined {
    return this._ownedProcess?.remote;
  }

  /** Executable used to start this server, independent of its configured ID. */
  get commandName(): string {
    return configuredExecutableName(this._command);
  }
  get diagnosticMode(): "unknown" | "pull" | "push" {
    return this._diagnosticMode;
  }

  setDiagnosticMode(mode: "pull" | "push"): void {
    this._diagnosticMode = mode;
  }

  /** Maximum wait for a server response, including pushed diagnostics. */
  get timeoutMs(): number {
    return this._timeoutMs;
  }

  /** Whether initialization advertised a server-specific executeCommand capability. */
  supportsCommand(command: string): boolean {
    const provider = this._serverCapabilities?.executeCommandProvider as
      | { commands?: unknown }
      | undefined;
    return Array.isArray(provider?.commands) && provider.commands.includes(command);
  }

  /** Whether initialization advertised support for workspace/symbol requests. */
  get hasWorkspaceSymbolCapability(): boolean {
    const provider = this._serverCapabilities?.workspaceSymbolProvider;
    return provider === true || (typeof provider === "object" && provider !== null);
  }
  get hasFoldingRangeCapability(): boolean {
    const provider = this._serverCapabilities?.foldingRangeProvider;
    return provider === true || (typeof provider === "object" && provider !== null);
  }

  /** Text last synchronized to the server, used to reject edits against stale open buffers. */
  documentContent(uri: string): string | undefined {
    return this._documentContents.get(uri);
  }
  documentVersion(uri: string): number | undefined {
    return this._documentVersions.get(uri);
  }

  /** Reuse a push that arrived after the latest synchronization, including an empty publication. */
  diagnosticPublication(uri: string): LspDiagnosticPublication | undefined {
    return this._diagnosticPublications.get(uri);
  }

  beginDiagnosticRequest(uri: string): void {
    this._activeDiagnosticRequests.add(uri);
  }

  endDiagnosticRequest(uri: string): void {
    this._activeDiagnosticRequests.delete(uri);
  }

  hasActiveDiagnosticRequest(uri: string): boolean {
    return this._activeDiagnosticRequests.has(uri);
  }

  /** Start this client with cancellation of its owned startup work. */
  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await this._start(signal);
    } catch (error) {
      try {
        await this.shutdown();
      } catch (cleanupError) {
        throw new AggregateError(
          [signal?.aborted ? signal.reason : error, cleanupError],
          `[lsp] ${this.serverId}: startup and cleanup failed`,
          { cause: cleanupError },
        );
      }
      signal?.throwIfAborted();
      throw error;
    }
  }

  private async _start(signal?: AbortSignal): Promise<void> {
    if (this._initialized) {
      return;
    }

    if (this._disposed) {
      throw new Error(`[lsp] ${this.serverId}: disposed`);
    }

    if (!this.rootUri.startsWith("file://") && !this._ownerTransport) {
      throw Object.assign(
        new Error("No language server process transport for this resource owner"),
        { code: "UNSUPPORTED_SOURCE" },
      );
    }
    await this._closeFileWatchers();
    signal?.throwIfAborted();
    // Shutdown can dispose this client while watcher cleanup is awaited.
    // eslint-disable-next-line typescript/no-unnecessary-condition
    if (this._disposed) throw new Error(`[lsp] ${this.serverId}: disposed`);
    const bin = requiredValue(this._command[0]);
    const projectRoot = this._ownerTransport
      ? decodeURIComponent(new URL(this.rootUri).pathname)
      : URI.parse(this.rootUri).fsPath;

    const workspaceFolders = [
      {
        uri: this._ownerTransport?.toServerUri(this.rootUri) ?? this.rootUri,
        name: path.basename(projectRoot) || projectRoot,
      },
    ];

    const watchFiles = this._ownerTransport
      ? this._ownerTransport.fileWatchers !== undefined
      : true;
    const initializeParameters = {
      processId: this._ownerTransport ? null : process.pid,
      rootUri: this._ownerTransport?.toServerUri(this.rootUri) ?? this.rootUri,

      workspaceFolders,
      capabilities: {
        workspace: {
          applyEdit: false,

          configuration: true,

          workspaceFolders: true,

          didChangeWatchedFiles: {
            dynamicRegistration: watchFiles,
            relativePatternSupport: watchFiles,
          },
          symbol: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: { didOpen: true, didChange: true, didClose: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },

          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          foldingRange: { lineFoldingOnly: true },
        },
      },
      initializationOptions: this._initOptions,
    };

    this._ownedStartup = this._ownerTransport?.start({
      rootUri: this.rootUri,
      command: this._command,
      env: this._env,
      signal,
    });
    const ownedProcess = await this._ownedStartup;
    this._ownedProcess = ownedProcess ?? null;
    signal?.throwIfAborted();
    // An owner can become ready while shutdown is waiting for it.
    // eslint-disable-next-line typescript/no-unnecessary-condition
    if (this._disposed) throw new Error(`[lsp] ${this.serverId}: disposed`);
    const sharedServer = ownedProcess
      ? undefined
      : await this._attachSharedServer(projectRoot, initializeParameters, signal);
    // Shutdown that ran during the attach could not see this connection.
    // eslint-disable-next-line typescript/no-unnecessary-condition
    if (this._disposed) {
      await sharedServer?.stop();
      throw new Error(`[lsp] ${this.serverId}: disposed`);
    }
    this._sharedServer = sharedServer ?? null;
    signal?.throwIfAborted();
    const childProcess =
      ownedProcess || sharedServer
        ? undefined
        : spawnProcess(bin, this._args, {
            stdio: ["pipe", "pipe", "pipe"],
            ...(signal && { signal }),
            cwd: projectRoot,
            env: createConfiguredProcessEnvironment(
              { command: this._command, env: this._env },
              projectRoot,
              process.env,
            ),
          });
    this._process = childProcess ?? null;
    const spawnPromise = childProcess ? waitForSpawn(childProcess) : Promise.resolve();
    const stream = ownedProcess ?? sharedServer;
    const stdin = requiredValue(stream?.stdin ?? childProcess?.stdin);
    const stdout = requiredValue(stream?.stdout ?? childProcess?.stdout);
    const stderr = requiredValue(stream?.stderr ?? childProcess?.stderr);

    // Consume process stream errors so a failed optional server cannot
    // become an uncaught exception in the host process.
    stdin.on("error", () => void 0);
    stdout.on("error", () => void 0);
    stderr.on("error", () => void 0);

    this._stderr = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      this._stderr = (this._stderr + chunk).slice(-4096);
    });

    childProcess?.on("error", (error) => {
      const code = "code" in error ? (error as { code?: unknown }).code : undefined;

      if (code !== "ENOENT") {
        console.error(`[lsp] ${this.serverId}: spawn failed:`, error);
      }

      this._crashed = true;
      this._connection?.dispose();
      this._connection = null;
      this._process = null;
    });

    const current = () =>
      ownedProcess
        ? this._ownedProcess === ownedProcess
        : sharedServer
          ? this._sharedServer === sharedServer
          : this._process === childProcess;
    const onExit = (code: number | null) => {
      if (!current()) return;
      void this._closeFileWatchers();
      if (!this._disposed && code !== 0 && code !== null) {
        this._crashed = true;
      }

      this._connection?.dispose();
      this._connection = null;
      this._diagnosticPublications.clear();
      this._activeDiagnosticRequests.clear();
      this._diagnosticMode = "unknown";
      this._versionedDiagnostics = false;
      this._process = null;
      this._initialized = false;
    };
    childProcess?.on("exit", onExit);
    void stream?.completion.then(
      ({ exitCode }) => onExit(exitCode),
      () => {
        if (!current()) return;
        this._crashed = true;
        onExit(null);
      },
    );

    await waitWithSignal(spawnPromise, signal);
    const connection = createMessageConnection(
      new StreamMessageReader(stdout),
      new TransportWriter(stdin, (error) => {
        if (this._connection !== connection || this._disposed) return;
        this._crashed = true;
        this._initialized = false;
        void this._closeFileWatchers();
        connection.dispose();
        console.error(`[lsp] ${this.serverId}: transport write failed:`, error);
      }),
    );
    this._connection = connection;

    this._connection.onError((error) => {
      console.error(`[lsp] ${this.serverId}: connection error:`, error);
    });

    const changed = (change: { uri: string; type: 1 | 2 | 3 }) => {
      this._sendNotification("workspace/didChangeWatchedFiles", { changes: [change] });
    };
    const failed = (error: Error) =>
      console.error(`[lsp] ${this.serverId}: file watcher failed:`, error);
    // A shared host watches files for its server itself.
    this._fileWatchers = this._ownerTransport
      ? this._ownerTransport.fileWatchers?.(this.rootUri, changed, failed)
      : sharedServer
        ? undefined
        : new LspFileWatchers(projectRoot, changed, failed);
    this._connection.onRequest(
      "client/registerCapability",
      async (parameters: {
        registrations: {
          id: string;
          method: string;
          registerOptions?: { watchers?: Parameters<LspFileWatchers["register"]>[1] };
        }[];
      }) => {
        for (const registration of parameters.registrations) {
          // Settings are fixed for this client and already served by workspace/configuration.
          if (registration.method === "workspace/didChangeConfiguration") continue;
          if (registration.method !== "workspace/didChangeWatchedFiles")
            throw new Error(`Unsupported dynamic capability: ${registration.method}`);
          if (!this._fileWatchers)
            throw new Error("File watching is unavailable for this server owner");
          await this._fileWatchers.register(
            registration.id,
            registration.registerOptions?.watchers ?? [],
          );
        }
        return null;
      },
    );
    this._connection.onRequest(
      "client/unregisterCapability",
      async (parameters: { unregisterations: { id: string }[] }) => {
        for (const registration of parameters.unregisterations)
          await this._fileWatchers?.unregister(registration.id);
        return null;
      },
    );
    this._connection.onRequest("window/workDoneProgress/create", () => null);

    this._connection.onRequest(
      "workspace/configuration",
      (parameters: { items: { section?: string }[] }) =>
        configurationItems(this._settings, parameters.items),
    );

    this._connection.listen();

    // Forward all incoming notifications to registered handlers
    this._connection.onNotification((method, ...parameters) => {
      const owner = this._ownerTransport;
      const mapped = owner
        ? mapLspUris(parameters[0], (uri) => owner.fromServerUri(uri))
        : parameters[0];
      if (method === "textDocument/publishDiagnostics") {
        const publication = mapped as
          | { uri?: unknown; version?: unknown; diagnostics?: unknown }
          | undefined;
        if (typeof publication?.version === "number") this._versionedDiagnostics = true;
        else if (
          this._versionedDiagnostics &&
          typeof publication?.uri === "string" &&
          this._documentVersions.has(publication.uri)
        )
          // A server that versions its reports omits the version only for a document it sees as
          // closed. Such a push for a document open here was sent before the server processed
          // the latest didOpen, for example the clear for a close that a quick reopen followed.
          return;
        if (
          publication &&
          typeof publication.uri === "string" &&
          Array.isArray(publication.diagnostics) &&
          this._documentVersions.has(publication.uri) &&
          (publication.version === undefined ||
            publication.version === this.documentVersion(publication.uri))
        ) {
          this._diagnosticPublications.set(publication.uri, {
            diagnostics: publication.diagnostics as LspDiagnostic[],
            ...(typeof publication.version === "number" && { version: publication.version }),
          });
        }
      }
      for (const handler of this._handlers.get(method) ?? []) {
        handler(mapped);
      }
    });

    this._connection.onRequest("workspace/workspaceFolders", () => workspaceFolders);

    interface InitResult {
      capabilities: Record<string, unknown>;
    }

    const initResult = await waitWithSignal(
      withTimeout(
        this._connection.sendRequest<InitResult>("initialize", initializeParameters),
        this._timeoutMs,
        `[lsp] ${this.serverId}: initialize timed out`,
      ),
      signal,
    ).catch((error: unknown) => {
      const detail = this._stderr.trim();
      if (!detail) throw error;
      throw new Error(`[lsp] ${this.serverId}: ${detail}`, { cause: error });
    });

    await this._connection.sendNotification("initialized", {
      capabilities: initResult.capabilities,
    });

    if (this._settings !== undefined) {
      await this._connection.sendNotification("workspace/didChangeConfiguration", {
        settings: this._settings,
      });
    }

    if (this._crashed)
      throw new Error(`[lsp] ${this.serverId}: transport failed during initialization`);

    signal?.throwIfAborted();
    this._initialized = true;
    this._serverCapabilities = initResult.capabilities;

    // Unadvertised methods may return null or internal errors rather than MethodNotFound.
    this._diagnosticMode = initResult.capabilities.diagnosticProvider ? "pull" : "push";
  }

  /** Reach a server shared with other Pi sessions; undefined means start an own process. */
  private async _attachSharedServer(
    projectRoot: string,
    initialize: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<LspSharedServer | undefined> {
    if (!this._sharedServers) return undefined;
    try {
      return await this._sharedServers.attach({
        serverId: this.serverId,
        command: this._command,
        cwd: projectRoot,
        configuredEnv: this._env,
        env: createConfiguredProcessEnvironment(
          { command: this._command, env: this._env },
          projectRoot,
          process.env,
        ),
        settings: this._settings,
        initialize,
        lingerMs: this._idleTimeoutMs ?? DEFAULT_SHARED_SERVER_LINGER_MS,
        timeoutMs: this._timeoutMs,
        ...(signal && { signal }),
      });
    } catch {
      signal?.throwIfAborted();
      // The shared host is optional: an own process gives the same results.
      return undefined;
    }
  }

  /** Restart the idle period; requests and open operations keep the server busy. */
  touch(): void {
    clearTimeout(this._idleTimer);
    this._idleTimer = undefined;
    if (this._idleTimeoutMs === undefined || this._disposed || this._busy) return;
    const timer = setTimeout(() => {
      if (this._idleTimer !== timer) return;
      this._idleTimer = undefined;
      if (this.ready && !this._busy) this._onIdle?.();
    }, this._idleTimeoutMs);
    timer.unref();
    this._idleTimer = timer;
  }

  private get _busy(): boolean {
    return this._pendingRequests > 0 || this._documentLeases.size > 0;
  }

  /**
   * Keep a document open for one operation. The returned release is idempotent; the last
   * release of a document closes it on the server.
   */
  retainDocument(uri: string): () => void {
    this._documentLeases.set(uri, (this._documentLeases.get(uri) ?? 0) + 1);
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this._documentLeases.get(uri) ?? 1) - 1;
      if (remaining > 0) {
        this._documentLeases.set(uri, remaining);
        return;
      }
      this._documentLeases.delete(uri);
      if (this.ready && this._documentVersions.has(uri)) this.closeDocument(uri);
      this.touch();
    };
  }

  async restart(signal?: AbortSignal): Promise<void> {
    await this.shutdown();
    void this._closeFileWatchers();
    this._connection?.dispose();
    this._connection = null;
    this._process = null;
    this._initialized = false;
    this._crashed = false;
    this._disposed = false;
    this._shutdownPromise = undefined;
    this._documentVersions.clear();
    this._documentContents.clear();
    this._diagnosticPublications.clear();
    this._diagnosticMode = "unknown";
    this._versionedDiagnostics = false;
    this._activeDiagnosticRequests.clear();
    this._serverCapabilities = null;
    await this.start(signal);
  }

  // ── LSP protocol ───────────────────────────────────────────────────

  /** Send a request, forwarding optional cancellation to the language server. */
  async sendRequest<T = unknown>(
    method: string,
    parameters: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    this._assertReady();
    signal?.throwIfAborted();
    this._pendingRequests++;
    this.touch();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this._sendRequest<T>(method, parameters, signal);
        } catch (error) {
          const delay = REQUEST_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isRetryableCancellation(error)) throw error;
          // The server dropped a stale result; ask again once it has applied the latest text.
          await delayWithSignal(delay, signal);
          this._assertReady();
        }
      }
    } finally {
      this._pendingRequests--;
      this.touch();
    }
  }

  private async _sendRequest<T>(
    method: string,
    parameters: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const owner = this._ownerTransport;
    const requestParameters = owner
      ? mapLspUris(parameters, (uri) => owner.toServerUri(uri))
      : parameters;
    const mapResult = (result: unknown): T =>
      (owner ? mapLspUris(result, (uri) => owner.fromServerUri(uri)) : result) as T;
    if (!signal)
      return mapResult(
        await requiredValue(this._connection).sendRequest(method, requestParameters),
      );
    const cancellation = new CancellationTokenSource();
    let onAbort: (() => void) | undefined;
    try {
      const request = requiredValue(this._connection).sendRequest<T>(
        method,
        requestParameters,
        cancellation.token,
      );
      return mapResult(
        await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            onAbort = () => {
              cancellation.cancel();
              reject(signal.reason);
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]),
      );
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      cancellation.dispose();
    }
  }

  /** Queue a notification; a failed write makes this client unavailable without escaping to Pi. */
  sendNotification(method: string, parameters: unknown): void {
    this._assertReady();
    this._sendNotification(method, parameters);
  }

  private _sendNotification(method: string, parameters: unknown): void {
    const connection = this._connection;
    if (!connection) return;
    const owner = this._ownerTransport;
    const mapped = owner ? mapLspUris(parameters, (uri) => owner.toServerUri(uri)) : parameters;
    void connection.sendNotification(method, mapped).catch((error: unknown) => {
      if (this._connection !== connection || this._disposed) return;
      this._crashed = true;
      this._initialized = false;
      void this._closeFileWatchers();
      connection.dispose();
      console.error(`[lsp] ${this.serverId}: notification ${method} failed:`, error);
    });
  }

  /**
   * Register a handler for an incoming notification.
   *
   * Multiple handlers can be registered for the same method.
   * Returns a function to unregister.
   */
  onNotification(method: string, handler: (parameters: unknown) => void): () => void {
    const list = this._handlers.get(method) ?? [];
    list.push(handler);
    this._handlers.set(method, list);
    return () => {
      const index = list.indexOf(handler);

      if (index !== -1) {
        list.splice(index, 1);
      }
    };
  }

  // ── document management ────────────────────────────────────────────

  toUri(input: string): string {
    return documentUri(input, this.rootUri);
  }

  /** Resolve an owned document to the server path for raw, non-LSP protocol commands. */
  serverDocumentPath(uri: string): string {
    const canonical = this.toUri(uri);
    const wireUri = this._ownerTransport?.toServerUri(canonical) ?? canonical;
    return this._ownerTransport
      ? decodeURIComponent(new URL(wireUri).pathname)
      : URI.parse(wireUri).fsPath;
  }
  openDocument(uri: string, text: string, languageId: string, version = 1): void {
    const currentVersion = this._documentVersions.get(uri);

    if (currentVersion !== undefined) {
      this.changeDocument(uri, text, Math.max(version, currentVersion + 1));
      return;
    }

    this._diagnosticPublications.delete(uri);
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
    this._documentVersions.set(uri, version);

    this._documentContents.set(uri, text);
  }

  /** Sync content, optionally reporting a completed disk write to servers that request saves. */
  syncDocument(uri: string, text: string, languageId: string, saved = false): void {
    if (this._documentContents.get(uri) === text) return;
    const currentVersion = this._documentVersions.get(uri);

    if (currentVersion === undefined) {
      this.openDocument(uri, text, languageId);
    } else {
      this.changeDocument(uri, text, currentVersion + 1);
    }
    const synchronization = this._serverCapabilities?.textDocumentSync;
    const save =
      typeof synchronization === "object" && synchronization !== null
        ? (synchronization as { save?: boolean | { includeText?: boolean } }).save
        : undefined;
    if (saved && save) {
      this.sendNotification("textDocument/didSave", {
        textDocument: { uri },
        ...(typeof save === "object" && save.includeText && { text }),
      });
    }
  }

  changeDocument(uri: string, text: string, version: number): void {
    const currentVersion = this._documentVersions.get(uri);
    const nextVersion = Math.max(version, (currentVersion ?? 0) + 1);
    this._diagnosticPublications.delete(uri);
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
    this._documentVersions.set(uri, nextVersion);

    this._documentContents.set(uri, text);
  }

  closeDocument(uri: string): void {
    this.sendNotification("textDocument/didClose", { textDocument: { uri } });
    this._documentVersions.delete(uri);

    this._documentContents.delete(uri);

    this._diagnosticPublications.delete(uri);
  }

  // ── cleanup ────────────────────────────────────────────────────────

  /** Await the same owned cleanup for every caller, including during failed startup. */
  shutdown(): Promise<void> {
    return (this._shutdownPromise ??= this._shutdown());
  }

  private async _shutdown(): Promise<void> {
    this._disposed = true;
    clearTimeout(this._idleTimer);
    this._idleTimer = undefined;

    const watcherCleanup = this._closeFileWatchers();

    if (this._connection && this._initialized) {
      try {
        await withTimeout(
          this._connection.sendRequest("shutdown"),
          Math.min(this._timeoutMs, 1000),
          `[lsp] ${this.serverId}: shutdown timed out`,
        );
        await this._connection.sendNotification("exit").catch(() => {
          /* ok */
        });
      } catch {
        /*
                server already dead
                */
      }
    }

    this._connection?.dispose();
    this._connection = null;

    const owned = this._ownedProcess ?? (await this._ownedStartup?.catch(() => undefined));
    this._ownedProcess = null;
    this._ownedStartup = undefined;
    const ownedCleanup = Promise.resolve().then(() => owned?.stop());
    const shared = this._sharedServer;
    this._sharedServer = null;
    const sharedCleanup = Promise.resolve().then(() => shared?.stop());
    const child = this._process;
    this._process = null;
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000).unref();
    }

    this._initialized = false;
    this._documentVersions.clear();
    this._documentContents.clear();
    this._diagnosticPublications.clear();
    this._diagnosticMode = "unknown";
    this._versionedDiagnostics = false;
    this._activeDiagnosticRequests.clear();
    this._serverCapabilities = null;
    const results = await Promise.allSettled([ownedCleanup, sharedCleanup, watcherCleanup]);
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, `[lsp] ${this.serverId}: owned cleanup failed`);
  }

  /** Await owned shutdown and keep any cleanup failure visible to the caller. */
  dispose(): Promise<void> {
    return this.shutdown();
  }

  private _closeFileWatchers(): Promise<void> {
    const watchers = this._fileWatchers;
    this._fileWatchers = undefined;
    if (watchers) {
      this._fileWatcherCleanup = this._fileWatcherCleanup
        .catch(() => undefined)
        .then(() => watchers.dispose());
      void this._fileWatcherCleanup.catch((error: unknown) => {
        console.error(`[lsp] ${this.serverId}: file watcher cleanup failed:`, error);
      });
    }
    return this._fileWatcherCleanup;
  }
  // ── internal ───────────────────────────────────────────────────────

  private _assertReady(): void {
    if (this._disposed) {
      throw new Error(`[lsp] ${this.serverId}: disposed`);
    }

    if (this._crashed) {
      throw new Error(`[lsp] ${this.serverId}: crashed — call restart()`);
    }

    if (!this._initialized) {
      throw new Error(`[lsp] ${this.serverId}: not started — call start()`);
    }

    if (!this._connection) {
      throw new Error(`[lsp] ${this.serverId}: connection lost`);
    }
  }
}

/** Waits before each retry of a request the server cancelled; about 1.5 s in total. */
const REQUEST_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
/** LSP error codes from the specification; vscode-jsonrpc defines only JSON-RPC ones. */
const CONTENT_MODIFIED = -32_801;
const SERVER_CANCELLED = -32_802;

/**
 * ContentModified (-32801): the document changed while the server computed the result.
 * ServerCancelled (-32802): the server dropped the request, for example while it reloads the
 * project; a diagnostic request is not retried when the server says retriggering will not help.
 */
function isRetryableCancellation(error: unknown): boolean {
  if (!(error instanceof ResponseError)) return false;
  if (error.code === CONTENT_MODIFIED) return true;
  if (error.code !== SERVER_CANCELLED) return false;
  const data: unknown = error.data;
  return !(
    data !== null &&
    typeof data === "object" &&
    "retriggerRequest" in data &&
    data.retriggerRequest === false
  );
}

function waitForSpawn(childProcess: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      childProcess.off("spawn", onSpawn);
      childProcess.off("error", onError);
    };

    const onSpawn = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    childProcess.once("spawn", onSpawn);
    childProcess.once("error", onError);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    void promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
        return undefined;
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      });
  });
}
