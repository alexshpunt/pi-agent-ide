import path from "node:path";

import { existsSync } from "node:fs";

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
  private readonly _lookup: LanguageLookup;

  private constructor(
    entries: readonly EffectiveToolConfigEntry<ServerConfig>[],
    availableBuiltIns: ReadonlySet<string>,
    private readonly _projectRoot: string,
  ) {
    this._entries = entries;
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
      path.resolve(packageDir),
    );
  }

  /**
  Creates a project-layer registry from an already-parsed config.
  */
  static fromConfig(config: LspServersConfig, projectRoot = process.cwd()): LspServerRegistry {
    return new LspServerRegistry(
      Object.entries(config.servers).map(([id, server]) => ({
        id,
        config: server,
        layer: "project",
        sourcePath: "<memory>",
      })),
      new Set(),
      path.resolve(projectRoot),
    );
  }

  /** Resolve a file path or extension to servers in layer priority order. */
  resolve(file: string): ResolvedServer[] {
    const basename = path.basename(file);
    const extension = path.extname(file) || (file.startsWith(".") ? file : `.${file}`);
    const normalizeName = (name: string) =>
      process.platform === "win32" ? name.toLowerCase() : name;
    const matches: ResolvedServer[] = [];
    for (const entry of this._entries) {
      if (!this._servers[entry.id]) continue;

      if (entry.config.requireRootMarker && !this.hasRootMarker(file, entry.config.rootMarkers))
        continue;
      for (const [languageId, language] of Object.entries(entry.config.languages)) {
        if (
          language.extensions.some(
            (candidate) => candidate.toLowerCase() === extension.toLowerCase(),
          ) ||
          language.fileNames?.some((name) => normalizeName(name) === normalizeName(basename))
        ) {
          matches.push({
            serverId: entry.id,
            config: entry.config,
            languageId,
            layer: entry.layer,
            sourcePath: entry.sourcePath,
          });
          break;
        }
      }
    }
    return matches;
  }

  private hasRootMarker(file: string, markers: readonly string[]): boolean {
    let directory = path.dirname(path.resolve(this._projectRoot, file));
    if (file.startsWith(".") && !file.includes(path.sep)) directory = this._projectRoot;
    for (;;) {
      const relative = path.relative(this._projectRoot, directory);
      // This checks containment; it does not construct a parent-relative path.
      // eslint-disable-next-line repo/no-parent-paths
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return false;
      if (markers.some((marker) => existsSync(path.join(directory, marker)))) return true;
      if (directory === this._projectRoot) return false;
      directory = path.dirname(directory);
    }
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
    return this.resolve(extension)[0]?.languageId ?? extension.slice(1);
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

    if (server.requireRootMarker !== undefined && typeof server.requireRootMarker !== "boolean") {
      throw new TypeError(`LSP server ${id}.requireRootMarker must be a boolean`);
    }
    if (server.requireRootMarker && (server.rootMarkers as string[]).length === 0) {
      throw new Error(`LSP server ${id}.requireRootMarker requires rootMarkers`);
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

      const fileNames = (languageValue as Record<string, unknown>).fileNames;
      if (
        fileNames !== undefined &&
        (!Array.isArray(fileNames) ||
          fileNames.some(
            (name) => typeof name !== "string" || name.length === 0 || /[/\\]/u.test(name),
          ))
      ) {
        throw new Error(`LSP server ${id} language ${language}.fileNames must contain basenames`);
      }
    }

    if (!Array.isArray(server.capabilities)) {
      throw new TypeError(`LSP server ${id}.capabilities must be an array`);
    }
  }

  return value as LspServersConfig;
}
