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
  StreamMessageReader,
} from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";

import type { LspDiagnostic } from "./types.js";

import { LspFileWatchers, type LspFileWatcherSubscriptions } from "./file-watchers.js";

import { TransportWriter } from "./transport-writer.js";
import { documentUri } from "./document-uri.js";
import { waitWithSignal } from "./abort.js";
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
  private readonly _activeDiagnosticRequests = new Set<string>();

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
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  get ready(): boolean {
    return this._initialized && !this._disposed;
  }

  get crashed(): boolean {
    return this._crashed;
  }

  get pid(): number | null {
    return this._process?.pid ?? null;
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
    const childProcess = ownedProcess
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
    const stdin = requiredValue(ownedProcess?.stdin ?? childProcess?.stdin);
    const stdout = requiredValue(ownedProcess?.stdout ?? childProcess?.stdout);
    const stderr = requiredValue(ownedProcess?.stderr ?? childProcess?.stderr);

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

    const onExit = (code: number | null) => {
      if (ownedProcess ? this._ownedProcess !== ownedProcess : this._process !== childProcess)
        return;
      void this._closeFileWatchers();
      if (!this._disposed && code !== 0 && code !== null) {
        this._crashed = true;
      }

      this._connection?.dispose();
      this._connection = null;
      this._diagnosticPublications.clear();
      this._activeDiagnosticRequests.clear();
      this._diagnosticMode = "unknown";
      this._process = null;
      this._initialized = false;
    };
    childProcess?.on("exit", onExit);
    void ownedProcess?.completion.then(
      ({ exitCode }) => onExit(exitCode),
      () => {
        if (this._ownedProcess !== ownedProcess) return;
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
    this._fileWatchers = this._ownerTransport
      ? this._ownerTransport.fileWatchers?.(this.rootUri, changed, failed)
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
        parameters.items.map((item) => {
          let value: unknown = this._settings ?? null;
          for (const segment of item.section?.split(".").filter(Boolean) ?? []) {
            value =
              typeof value === "object" && value !== null
                ? ((value as Record<string, unknown>)[segment] ?? null)
                : null;
          }
          return value;
        }),
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
        this._connection.sendRequest<InitResult>("initialize", {
          processId: this._ownerTransport ? null : process.pid,
          rootUri: this._ownerTransport?.toServerUri(this.rootUri) ?? this.rootUri,

          workspaceFolders,
          capabilities: {
            workspace: {
              applyEdit: false,

              configuration: true,

              workspaceFolders: true,

              didChangeWatchedFiles: {
                dynamicRegistration: this._fileWatchers !== undefined,
                relativePatternSupport: this._fileWatchers !== undefined,
              },
              symbol: { dynamicRegistration: false },
            },
            textDocument: {
              synchronization: { didOpen: true, didChange: true, didClose: true },
              publishDiagnostics: { relatedInformation: true },

              diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              foldingRange: { lineFoldingOnly: true },
            },
          },
          initializationOptions: this._initOptions,
        }),
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

  touch(): void {
    // LSP server lives for the session duration — no idle timeout
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
    this._activeDiagnosticRequests.clear();
    this._serverCapabilities = null;
    const results = await Promise.allSettled([ownedCleanup, watcherCleanup]);
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
