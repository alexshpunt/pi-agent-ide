import { requiredValue } from "pi-agent-invariant";
import { type ChildProcess } from "node:child_process";

import path from "node:path";

import spawnProcess from "cross-spawn";
import { createConfiguredProcessEnvironment } from "pi-agent-ide/api/tool-config";
import {
  createMessageConnection,
  CancellationTokenSource,
  type MessageConnection,
  StreamMessageReader,
} from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";

import type { LspDiagnostic } from "./types.js";

import { LspFileWatchers } from "./file-watchers.js";

import { TransportWriter } from "./transport-writer.js";

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
  private _connection: MessageConnection | null = null;
  private _initialized = false;
  private _serverCapabilities: Record<string, unknown> | null = null;
  private _disposed = false;

  private _crashed = false;

  private _stderr = "";

  private _fileWatchers: LspFileWatchers | undefined;
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
  }) {
    this.serverId = parameters.serverId;
    this.rootUri = parameters.rootUri;
    this._command = parameters.command;
    this._args = parameters.command.slice(1);
    this._env = parameters.env ?? {};
    this._initOptions = parameters.initOptions;
    this._settings = parameters.settings;
    this._timeoutMs = parameters.timeoutMs ?? 30_000;
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

  get hasFoldingRangeCapability(): boolean {
    const provider = this._serverCapabilities?.foldingRangeProvider;
    return provider === true || (typeof provider === "object" && provider !== null);
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

  async start(): Promise<void> {
    if (this._initialized) {
      return;
    }

    if (this._disposed) {
      throw new Error(`[lsp] ${this.serverId}: disposed`);
    }

    const bin = requiredValue(this._command[0]);
    const projectRoot = URI.parse(this.rootUri).fsPath;

    const workspaceFolders = [
      { uri: this.rootUri, name: path.basename(projectRoot) || projectRoot },
    ];

    const childProcess = spawnProcess(bin, this._args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: projectRoot,
      env: createConfiguredProcessEnvironment(
        { command: this._command, env: this._env },
        projectRoot,
        process.env,
      ),
    });
    this._process = childProcess;
    const spawnPromise = waitForSpawn(childProcess);

    // Consume process stream errors so a failed optional server cannot
    // become an uncaught exception in the host process.
    childProcess.stdin?.on("error", () => void 0);
    childProcess.stdout?.on("error", () => void 0);
    childProcess.stderr?.on("error", () => void 0);

    this._stderr = "";
    childProcess.stderr?.setEncoding("utf8");
    childProcess.stderr?.on("data", (chunk: string) => {
      this._stderr = (this._stderr + chunk).slice(-4096);
    });

    childProcess.on("error", (error) => {
      const code = "code" in error ? (error as { code?: unknown }).code : undefined;

      if (code !== "ENOENT") {
        console.error(`[lsp] ${this.serverId}: spawn failed:`, error);
      }

      this._crashed = true;
      this._connection?.dispose();
      this._connection = null;
      this._process = null;
    });

    childProcess.on("exit", (code, _signal) => {
      this._fileWatchers?.dispose();
      if (!this._disposed && code !== 0 && code !== null) {
        this._crashed = true;
      }

      this._connection?.dispose();
      this._connection = null;
      this._process = null;
      this._initialized = false;
    });

    await spawnPromise;
    const connection = createMessageConnection(
      new StreamMessageReader(requiredValue(childProcess.stdout)),
      new TransportWriter(requiredValue(childProcess.stdin), (error) => {
        if (this._connection !== connection || this._disposed) return;
        this._crashed = true;
        this._initialized = false;
        this._fileWatchers?.dispose();
        connection.dispose();
        console.error(`[lsp] ${this.serverId}: transport write failed:`, error);
      }),
    );
    this._connection = connection;

    this._connection.onError((error) => {
      console.error(`[lsp] ${this.serverId}: connection error:`, error);
    });

    this._fileWatchers = new LspFileWatchers(
      projectRoot,
      (change) => {
        this._sendNotification("workspace/didChangeWatchedFiles", { changes: [change] });
      },
      (error) => console.error(`[lsp] ${this.serverId}: file watcher failed:`, error),
    );
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
          await this._fileWatchers?.register(
            registration.id,
            registration.registerOptions?.watchers ?? [],
          );
        }
        return null;
      },
    );
    this._connection.onRequest(
      "client/unregisterCapability",
      (parameters: { unregisterations: { id: string }[] }) => {
        for (const registration of parameters.unregisterations)
          this._fileWatchers?.unregister(registration.id);
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
      if (method === "textDocument/publishDiagnostics") {
        const publication = parameters[0] as
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
        handler(parameters[0] as unknown);
      }
    });

    this._connection.onRequest("workspace/workspaceFolders", () => workspaceFolders);

    interface InitResult {
      capabilities: Record<string, unknown>;
    }

    const initResult = await withTimeout(
      this._connection.sendRequest<InitResult>("initialize", {
        processId: process.pid,
        rootUri: this.rootUri,

        workspaceFolders,
        capabilities: {
          workspace: {
            applyEdit: false,

            configuration: true,

            workspaceFolders: true,

            didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
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

    this._initialized = true;
    this._serverCapabilities = initResult.capabilities;

    // Unadvertised methods may return null or internal errors rather than MethodNotFound.
    this._diagnosticMode = initResult.capabilities.diagnosticProvider ? "pull" : "push";
  }

  touch(): void {
    // LSP server lives for the session duration — no idle timeout
  }

  async restart(): Promise<void> {
    this._fileWatchers?.dispose();
    this._connection?.dispose();
    this._connection = null;
    this._process = null;
    this._initialized = false;
    this._crashed = false;
    this._disposed = false;
    this._documentVersions.clear();
    this._documentContents.clear();
    this._diagnosticPublications.clear();
    this._diagnosticMode = "unknown";
    this._activeDiagnosticRequests.clear();
    this._serverCapabilities = null;
    await this.start();
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
    if (!signal) return requiredValue(this._connection).sendRequest(method, parameters);
    const cancellation = new CancellationTokenSource();
    let onAbort: (() => void) | undefined;
    try {
      const request = requiredValue(this._connection).sendRequest<T>(
        method,
        parameters,
        cancellation.token,
      );
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            cancellation.cancel();
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
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
    void connection.sendNotification(method, parameters).catch((error: unknown) => {
      if (this._connection !== connection || this._disposed) return;
      this._crashed = true;
      this._initialized = false;
      this._fileWatchers?.dispose();
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
    if (input.startsWith("file://")) {
      return input;
    }

    return URI.file(input).toString();
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

  async shutdown(): Promise<void> {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    this._fileWatchers?.dispose();

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

    if (this._process && !this._process.killed) {
      this._process.kill("SIGTERM");
      setTimeout(() => {
        if (this._process && !this._process.killed) {
          this._process.kill("SIGKILL");
        }
      }, 2000).unref();
    }

    this._initialized = false;
    this._documentVersions.clear();
    this._documentContents.clear();
    this._diagnosticPublications.clear();
    this._diagnosticMode = "unknown";
    this._activeDiagnosticRequests.clear();
    this._serverCapabilities = null;
  }

  dispose(): void {
    void this.shutdown();
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
