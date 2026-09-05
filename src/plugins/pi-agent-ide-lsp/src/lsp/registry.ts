import { requiredValue } from "pi-agent-invariant";

import { hasConfiguredExecutable, loadLayeredToolConfig } from "pi-agent-ide/api/tool-config";

import { buildLanguageLookup, type LanguageLookup } from "./language-map.js";

import type {
  EffectiveToolConfigEntry,
  LayeredToolConfigOptions,
} from "pi-agent-ide/api/tool-config";
import type { LspServersConfig, ResolvedServer, ServerConfig } from "./types.js";

/**
LSP server configuration in project, global, and built-in priority order.
*/
export class LspServerRegistry {
  private readonly _servers: Record<string, ServerConfig>;
  private readonly _entries: readonly EffectiveToolConfigEntry<ServerConfig>[];
  private readonly _entriesById: ReadonlyMap<string, EffectiveToolConfigEntry<ServerConfig>>;
  private readonly _lookup: LanguageLookup;

  private constructor(
    entries: readonly EffectiveToolConfigEntry<ServerConfig>[],
    availableBuiltIns: ReadonlySet<string>,
  ) {
    this._entries = entries;
    this._entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const activeEntries = entries.filter(
      (entry) => entry.layer !== "built-in" || availableBuiltIns.has(entry.id),
    );
    this._servers = Object.fromEntries(activeEntries.map((entry) => [entry.id, entry.config]));
    this._lookup = buildLanguageLookup(this._servers);
  }

  /**
  Loads and merges project, global, and built-in `lsp-servers.json` files.
  */
  static async fromPackageDir(
    packageDir: string,
    options: LayeredToolConfigOptions = {},
  ): Promise<LspServerRegistry> {
    const effective = await loadLayeredToolConfig(
      packageDir,
      "lsp-servers",
      (value) => parseLspConfig(value).servers,
      options,
    );
    const environment = options.environment ?? process.env;
    const available = await Promise.all(
      effective.entries
        .filter((entry) => entry.layer === "built-in")
        .map(async (entry) => ({
          id: entry.id,
          available: await hasConfiguredExecutable(entry.config, packageDir, environment),
        })),
    );
    return new LspServerRegistry(
      effective.entries,
      new Set(available.filter((entry) => entry.available).map((entry) => entry.id)),
    );
  }

  /**
  Creates a project-layer registry from an already-parsed config.
  */
  static fromConfig(config: LspServersConfig): LspServerRegistry {
    return new LspServerRegistry(
      Object.entries(config.servers).map(([id, server]) => ({
        id,
        config: server,
        layer: "project",
        sourcePath: "<memory>",
      })),
      new Set(),
    );
  }

  /**
  Resolves a file extension to matching LSP servers in layer priority order.
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

    return serverIds.map((serverId) => {
      const entry = requiredValue(this._entriesById.get(serverId));
      return {
        serverId,
        config: entry.config,
        languageId,
        layer: entry.layer,
        sourcePath: entry.sourcePath,
      };
    });
  }

  /**
  All effective server configurations by stable ID.
  */
  get servers(): Readonly<Record<string, ServerConfig>> {
    return this._servers;
  }

  /**
  All merged server entries in runtime resolution order.
  */
  get entries(): readonly EffectiveToolConfigEntry<ServerConfig>[] {
    return this._entries;
  }

  /**
  All known extensions (with leading dot, lowercased).
  */
  get knownExtensions(): ReadonlySet<string> {
    return new Set(this._lookup.extToLanguageId.keys());
  }

  /**
  Resolves a file extension to the canonical LSP languageId.
  */
  languageId(extension: string): string {
    const normalized = extension.startsWith(".")
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    return this._lookup.extToLanguageId.get(normalized) ?? extension.slice(1);
  }
}

/**
Validates and returns an LSP server configuration object.
*/
export function parseLspConfig(value: unknown): LspServersConfig {
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
