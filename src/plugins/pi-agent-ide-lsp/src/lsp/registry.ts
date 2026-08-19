import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildLanguageLookup, type LanguageLookup } from "./language-map.js";

import type { LspServersConfig, ResolvedServer, ServerConfig } from "./types.js";

/**
 * LspServerRegistry — loads lsp-servers.json and resolves
 * file extensions to LSP server configurations.
 *
 * Thread-safe: all mutations happen at construction time.
 */
export class LspServerRegistry
{
    private readonly _servers: Record<string, ServerConfig>;
    private readonly _lookup: LanguageLookup;

    private constructor(config: LspServersConfig)
    {
        this._servers = config.servers;
        this._lookup = buildLanguageLookup(this._servers);
    }

    /**
     * Load and parse the lsp-servers.json from the project package directory.
     */
    static async fromPackageDir(packageDir: string): Promise<LspServerRegistry>
    {
        const configPath = path.join(packageDir, "lsp-servers.json");
        const raw = await readFile(configPath, "utf8");
        const config = JSON.parse(raw) as LspServersConfig;
        return new LspServerRegistry(config);
    }

    /**
     * Create from an already-parsed config (for testing).
     */
    static fromConfig(config: LspServersConfig): LspServerRegistry
    {
        return new LspServerRegistry(config);
    }

    /**
     * Resolve a file extension (with or without leading dot) to its LSP servers.
     * Returns empty array if no LSP server is configured for this extension.
     */
    resolve(ext: string): ResolvedServer[]
    {
        const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
        const serverIds = this._lookup.extToServerIds.get(normalized);

        if (!serverIds || serverIds.length === 0)
        {
            return [];
        }

        const languageId = this._lookup.extToLanguageId.get(normalized);

        if (!languageId)
        {
            return [];
        }

        return serverIds.map((serverId) => ({
            serverId,
            config: this._servers[serverId]!,
            languageId,
        }));
    }

    /**
     * All registered server configurations.
     */
    get servers(): Readonly<Record<string, ServerConfig>>
    {
        return this._servers;
    }

    /**
     * All known extensions (with leading dot, lowercased).
     */
    get knownExtensions(): ReadonlySet<string>
    {
        return new Set(this._lookup.extToLanguageId.keys());
    }

    /**
     * Resolve a file extension to the canonical LSP languageId.
     * Returns the extension without dot as fallback if not found.
     */
    languageId(ext: string): string
    {
        const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
        return this._lookup.extToLanguageId.get(normalized) ?? ext.slice(1);
    }
}
