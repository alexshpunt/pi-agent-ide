import { type ChildProcess } from "node:child_process";

import spawnProcess from "cross-spawn";
import {
    createMessageConnection,
    type MessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";

/**
 * Generic LSP client — JSON-RPC over stdio.
 *
 * Language-agnostic. One instance per LSP server process.
 * Handles initialize → initialized → keep-alive → shutdown lifecycle.
 */
export class LspClient
{
    private _process: ChildProcess | null = null;
    private _connection: MessageConnection | null = null;
    private _initialized = false;
    private _serverCapabilities: Record<string, unknown> | null = null;
    private _disposed = false;

    private _crashed = false;
    private readonly _handlers = new Map<string, ((params: unknown) => void)[]>();
    private readonly _documentVersions = new Map<string, number>();
    private _diagnosticMode: "unknown" | "pull" | "push" = "unknown";
    private readonly _activeDiagnosticRequests = new Set<string>();

    readonly serverId: string;
    readonly rootUri: string;
    private readonly _command: string[];
    private readonly _args: string[];
    private readonly _env: Record<string, string>;
    private readonly _initOptions: Record<string, unknown> | undefined;

    constructor(params: {
        serverId: string;
        rootUri: string;
        command: string[];
        env?: Record<string, string>;
        initOptions?: Record<string, unknown>;
    })
    {
        this.serverId = params.serverId;
        this.rootUri = params.rootUri;
        this._command = params.command;
        this._args = params.command.slice(1);
        this._env = params.env ?? {};
        this._initOptions = params.initOptions;
    }

    // ── lifecycle ──────────────────────────────────────────────────────

    get ready(): boolean
    {
        return this._initialized && !this._disposed;
    }

    get crashed(): boolean
    {
        return this._crashed;
    }

    get pid(): number | null
    {
        return this._process?.pid ?? null;
    }

    get diagnosticMode(): "unknown" | "pull" | "push"
    {
        return this._diagnosticMode;
    }

    setDiagnosticMode(mode: "pull" | "push"): void
    {
        this._diagnosticMode = mode;
    }

    get hasServerDiagnosticsCapability(): boolean
    {
        if (!this._serverCapabilities)
        {
            return false;
        }

        const td = this._serverCapabilities.textDocument as Record<string, unknown> | undefined;

        if (!td)
        {
            return false;
        }

        // Pull-model diagnostic (LSP 3.17+)
        if (td.diagnostic)
        {
            return true;
        }

        // Push-model publishDiagnostics
        if (td.publishDiagnostics)
        {
            return true;
        }

        return false;
    }

    get hasFoldingRangeCapability(): boolean
    {
        const provider = this._serverCapabilities?.foldingRangeProvider;
        return provider === true || (typeof provider === "object" && provider !== null);
    }

    documentVersion(uri: string): number | undefined
    {
        return this._documentVersions.get(uri);
    }

    beginDiagnosticRequest(uri: string): void
    {
        this._activeDiagnosticRequests.add(uri);
    }

    endDiagnosticRequest(uri: string): void
    {
        this._activeDiagnosticRequests.delete(uri);
    }

    hasActiveDiagnosticRequest(uri: string): boolean
    {
        return this._activeDiagnosticRequests.has(uri);
    }

    async start(): Promise<void>
    {
        if (this._initialized)
        {
            return;
        }

        if (this._disposed)
        {
            throw new Error(`[lsp] ${this.serverId}: disposed`);
        }

        const bin = this._command[0]!;

        const childProcess = spawnProcess(bin, this._args, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: URI.parse(this.rootUri).fsPath,
            env: { ...process.env, ...this._env },
        });
        this._process = childProcess;
        const spawnPromise = waitForSpawn(childProcess);

        // Consume process stream errors so a failed optional server cannot
        // become an uncaught exception in the host process.
        childProcess.stdin?.on("error", () => void 0);
        childProcess.stdout?.on("error", () => void 0);
        childProcess.stderr?.on("error", () => void 0);

        childProcess.on("error", (err) =>
        {
            const code = "code" in err ? (err as { code?: unknown; }).code : undefined;

            if (code !== "ENOENT")
            {
                console.error(`[lsp] ${this.serverId}: spawn failed:`, err);
            }

            this._crashed = true;
            this._connection?.dispose();
            this._connection = null;
            this._process = null;
        });

        childProcess.on("exit", (code, _signal) =>
        {
            if (!this._disposed && code !== 0 && code !== null)
            {
                this._crashed = true;
            }

            this._connection?.dispose();
            this._connection = null;
            this._process = null;
            this._initialized = false;
        });

        await spawnPromise;
        this._connection = createMessageConnection(
            new StreamMessageReader(childProcess.stdout!),
            new StreamMessageWriter(childProcess.stdin!),
        );

        this._connection.onError((err) =>
        {
            console.error(`[lsp] ${this.serverId}: connection error:`, err);
        });

        this._connection.listen();

        // Forward all incoming notifications to registered handlers
        this._connection.onNotification((method, ...params) =>
        {
            for (const handler of this._handlers.get(method) ?? [])
            {
                handler(params[0] as unknown);
            }
        });

        interface InitResult
        {
            capabilities: Record<string, unknown>;
        }

        const initResult: InitResult = await this._connection.sendRequest("initialize", {
            processId: process.pid,
            rootUri: this.rootUri,
            capabilities: {
                workspace: {
                    applyEdit: false,
                    symbol: { dynamicRegistration: false },
                },
                textDocument: {
                    synchronization: { didOpen: true, didChange: true, didClose: true },
                    publishDiagnostics: { relatedInformation: true },
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    foldingRange: { lineFoldingOnly: true },
                },
            },
            initializationOptions: this._initOptions,
        });

        void this._connection.sendNotification("initialized", {
            capabilities: initResult.capabilities,
        });

        this._initialized = true;
        this._serverCapabilities = initResult.capabilities;
    }

    touch(): void
    {
        // LSP server lives for the session duration — no idle timeout
    }

    async restart(): Promise<void>
    {
        this._connection?.dispose();
        this._connection = null;
        this._process = null;
        this._initialized = false;
        this._crashed = false;
        this._disposed = false;
        this._documentVersions.clear();
        this._diagnosticMode = "unknown";
        this._activeDiagnosticRequests.clear();
        this._serverCapabilities = null;
        await this.start();
    }

    // ── LSP protocol ───────────────────────────────────────────────────

    async sendRequest<T = unknown>(method: string, params: unknown): Promise<T>
    {
        this._assertReady();
        return this._connection!.sendRequest(method, params);
    }

    sendNotification(method: string, params: unknown): void
    {
        this._assertReady();
        void this._connection!.sendNotification(method, params);
    }

    /**
     * Register a handler for an incoming notification.
     *
     * Multiple handlers can be registered for the same method.
     * Returns a function to unregister.
     */
    onNotification(method: string, handler: (params: unknown) => void): () => void
    {
        const list = this._handlers.get(method) ?? [];
        list.push(handler);
        this._handlers.set(method, list);
        return () =>
        {
            const idx = list.indexOf(handler);

            if (idx !== -1)
            {
                list.splice(idx, 1);
            }
        };
    }

    // ── document management ────────────────────────────────────────────

    toUri(input: string): string
    {
        if (input.startsWith("file://"))
        {
            return input;
        }

        return URI.file(input).toString();
    }

    openDocument(uri: string, text: string, languageId: string, version = 1): void
    {
        const currentVersion = this._documentVersions.get(uri);

        if (currentVersion !== undefined)
        {
            this.changeDocument(uri, text, Math.max(version, currentVersion + 1));
            return;
        }

        this.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId, version, text },
        });
        this._documentVersions.set(uri, version);
    }

    syncDocument(uri: string, text: string, languageId: string): void
    {
        const currentVersion = this._documentVersions.get(uri);

        if (currentVersion === undefined)
        {
            this.openDocument(uri, text, languageId);
            return;
        }

        this.changeDocument(uri, text, currentVersion + 1);
    }

    changeDocument(uri: string, text: string, version: number): void
    {
        const currentVersion = this._documentVersions.get(uri);
        const nextVersion = Math.max(version, (currentVersion ?? 0) + 1);
        this.sendNotification("textDocument/didChange", {
            textDocument: { uri, version: nextVersion },
            contentChanges: [{ text }],
        });
        this._documentVersions.set(uri, nextVersion);
    }

    closeDocument(uri: string): void
    {
        this.sendNotification("textDocument/didClose", { textDocument: { uri } });
        this._documentVersions.delete(uri);
    }

    // ── cleanup ────────────────────────────────────────────────────────

    async shutdown(): Promise<void>
    {
        if (this._disposed)
        {
            return;
        }

        this._disposed = true;

        if (this._connection && this._initialized)
        {
            try
            {
                await this._connection.sendRequest("shutdown");
                await this._connection.sendNotification("exit").catch(() =>
                {/* ok */});
            }
            catch
            {
                /* server already dead */
            }
        }

        this._connection?.dispose();
        this._connection = null;

        if (this._process && !this._process.killed)
        {
            this._process.kill("SIGTERM");
            setTimeout(() =>
            {
                if (this._process && !this._process.killed)
                {
                    this._process.kill("SIGKILL");
                }
            }, 2000).unref();
        }

        this._initialized = false;
        this._documentVersions.clear();
        this._diagnosticMode = "unknown";
        this._activeDiagnosticRequests.clear();
        this._serverCapabilities = null;
    }

    dispose(): void
    {
        void this.shutdown();
    }

    // ── internal ───────────────────────────────────────────────────────

    private _assertReady(): void
    {
        if (this._disposed)
        {
            throw new Error(`[lsp] ${this.serverId}: disposed`);
        }

        if (this._crashed)
        {
            throw new Error(`[lsp] ${this.serverId}: crashed — call restart()`);
        }

        if (!this._initialized)
        {
            throw new Error(`[lsp] ${this.serverId}: not started — call start()`);
        }

        if (!this._connection)
        {
            throw new Error(`[lsp] ${this.serverId}: connection lost`);
        }
    }
}

function waitForSpawn(childProcess: ChildProcess): Promise<void>
{
    return new Promise<void>((resolve, reject) =>
    {
        const cleanup = () =>
        {
            childProcess.off("spawn", onSpawn);
            childProcess.off("error", onError);
        };

        const onSpawn = () =>
        {
            cleanup();
            resolve();
        };

        const onError = (error: Error) =>
        {
            cleanup();
            reject(error);
        };

        childProcess.once("spawn", onSpawn);
        childProcess.once("error", onError);
    });
}
