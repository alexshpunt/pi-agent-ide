import { requiredValue } from "../../../../utils/required-value.js";
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
export class LspServerRegistry {
  private readonly _servers: Record<string, ServerConfig>;
  private readonly _lookup: LanguageLookup;

  private constructor(config: LspServersConfig) {
    this._servers = config.servers;
    this._lookup = buildLanguageLookup(this._servers);
  }

  /**
   * Load and parse the lsp-servers.json from the project package directory.
   */
  static async fromPackageDir(packageDir: string): Promise<LspServerRegistry> {
    const configPath = path.join(packageDir, ".pi", "pi-agent-ide", "lsp-servers.json");
    let raw: string;

    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return new LspServerRegistry({ version: 1, servers: {} });
      }

      throw error;
    }

    return new LspServerRegistry(parseLspConfig(JSON.parse(raw)));
  }

  /**
   * Create from an already-parsed config (for testing).
   */
  static fromConfig(config: LspServersConfig): LspServerRegistry {
    return new LspServerRegistry(config);
  }

  /**
   * Resolve a file extension (with or without leading dot) to its LSP servers.
   * Returns empty array if no LSP server is configured for this extension.
   */
  resolve(extension: string): ResolvedServer[] {
    const normalized = extension.startsWith(".")
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    const serverIds = this._lookup.extToServerIds.get(normalized);

    if (!serverIds || serverIds.length === 0) {
      return [];
    }

    const languageId = this._lookup.extToLanguageId.get(normalized);

    if (!languageId) {
      return [];
    }

    return serverIds.map((serverId) => ({
      serverId,
      config: requiredValue(this._servers[serverId]),
      languageId,
    }));
  }

  /**
   * All registered server configurations.
   */
  get servers(): Readonly<Record<string, ServerConfig>> {
    return this._servers;
  }

  /**
   * All known extensions (with leading dot, lowercased).
   */
  get knownExtensions(): ReadonlySet<string> {
    return new Set(this._lookup.extToLanguageId.keys());
  }

  /**
   * Resolve a file extension to the canonical LSP languageId.
   * Returns the extension without dot as fallback if not found.
   */
  languageId(extension: string): string {
    const normalized = extension.startsWith(".")
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    return this._lookup.extToLanguageId.get(normalized) ?? extension.slice(1);
  }
}

function parseLspConfig(value: unknown): LspServersConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LSP config must be an object");
  }

  const root = value as Record<string, unknown>;

  if (root.version !== 1) {
    throw new Error("LSP config version must be 1");
  }

  if (typeof root.servers !== "object" || root.servers === null || Array.isArray(root.servers)) {
    throw new Error("LSP config servers must be an object");
  }

  for (const [id, serverValue] of Object.entries(root.servers)) {
    if (typeof serverValue !== "object" || serverValue === null || Array.isArray(serverValue)) {
      throw new Error(`LSP server ${id} must be an object`);
    }

    const server = serverValue as Record<string, unknown>;

    if (
      !Array.isArray(server.command) ||
      server.command.length === 0 ||
      server.command.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      throw new Error(`LSP server ${id}.command must be a non-empty string array`);
    }

    if (server.transport !== undefined && server.transport !== "stdio") {
      throw new Error(`LSP server ${id} only supports stdio transport`);
    }

    if (
      !Array.isArray(server.rootMarkers) ||
      server.rootMarkers.some((part) => typeof part !== "string")
    ) {
      throw new Error(`LSP server ${id}.rootMarkers must be a string array`);
    }

    if (
      typeof server.languages !== "object" ||
      server.languages === null ||
      Array.isArray(server.languages)
    ) {
      throw new Error(`LSP server ${id}.languages must be an object`);
    }

    for (const [language, languageValue] of Object.entries(
      server.languages as Record<string, unknown>,
    )) {
      const extensions =
        typeof languageValue === "object" && languageValue !== null && !Array.isArray(languageValue)
          ? (languageValue as Record<string, unknown>).extensions
          : undefined;

      if (
        !Array.isArray(extensions) ||
        extensions.length === 0 ||
        extensions.some((part) => typeof part !== "string")
      ) {
        throw new Error(`LSP server ${id} language ${language} requires extensions`);
      }
    }

    if (!Array.isArray(server.capabilities)) {
      throw new TypeError(`LSP server ${id}.capabilities must be an array`);
    }
  }

  return value as LspServersConfig;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
