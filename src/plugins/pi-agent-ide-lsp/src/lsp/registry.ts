import path from "node:path";

import { existsSync } from "node:fs";

import { inspectRecipeEvidence, type RecipeEvidence } from "pi-agent-doctor/api/evidence";
import type { ToolRecipe } from "pi-agent-doctor/api/catalog";
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
    options: LayeredToolConfigOptions & {
      readonly recipes?: readonly ToolRecipe[];
      /** Inspect native project evidence through the same owner as the configured processes. */
      readonly recipeEvidence?: (
        recipes: readonly ToolRecipe[],
      ) => Promise<ReadonlyMap<string, RecipeEvidence>>;
      /** Owner-side availability check; remote registries must not probe the controller. */
      readonly executableAvailable?: (config: ServerConfig) => Promise<boolean>;
      /** Probe a shipped candidate set in one owner request, avoiding per-tool transport startup. */
      readonly executableAvailability?: (
        configs: readonly ServerConfig[],
      ) => Promise<readonly boolean[]>;
    } = {},
  ): Promise<LspServerRegistry> {
    options.signal?.throwIfAborted();
    const effective = await loadLayeredToolConfig(
      packageDir,
      "lsp-servers",
      (value) => parseLspConfig(value).servers,
      options,
    );
    options.signal?.throwIfAborted();
    if (
      packageDir.startsWith("ssh://") &&
      ((!options.executableAvailable && !options.executableAvailability) ||
        (options.requireBuiltInEvidence && !options.recipeEvidence))
    )
      throw Object.assign(
        new Error("Remote language server availability needs its workspace owner"),
        { code: "UNSUPPORTED_SOURCE" },
      );
    const environment = options.environment ?? process.env;
    const builtIns = effective.entries.filter((entry) => entry.layer === "built-in");
    const available: { id: string; available: boolean }[] = [];
    if (options.executableAvailability) {
      const results = await options.executableAvailability(builtIns.map((entry) => entry.config));
      if (
        results.length !== builtIns.length ||
        results.some((result) => typeof result !== "boolean")
      )
        throw new TypeError("Invalid owner executable availability report");
      for (const [index, entry] of builtIns.entries())
        available.push({ id: entry.id, available: results[index] === true });
    } else if (options.executableAvailable) {
      // Owner probes may open SSH connections; do not flood connection startup limits.
      for (const entry of builtIns)
        available.push({
          id: entry.id,
          available: await options.executableAvailable(entry.config),
        });
    } else {
      available.push(
        ...(await Promise.all(
          builtIns.map(async (entry) => ({
            id: entry.id,
            available: await hasConfiguredExecutable(
              entry.config,
              packageDir,
              environment,
              options.signal,
            ),
          })),
        )),
      );
    }
    options.signal?.throwIfAborted();
    const evidence = options.requireBuiltInEvidence
      ? options.recipeEvidence
        ? await options.recipeEvidence(options.recipes ?? [])
        : await inspectRecipeEvidence(packageDir, options.recipes ?? [], undefined, options.signal)
      : undefined;
    options.signal?.throwIfAborted();
    return new LspServerRegistry(
      effective.entries,
      new Set(
        available
          .filter(
            (entry) =>
              entry.available &&
              (evidence === undefined || (evidence.get(entry.id)?.score ?? 0) > 0),
          )
          .map((entry) => entry.id),
      ),
      packageDir.startsWith("ssh://") ? packageDir : path.resolve(packageDir),
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
      projectRoot.startsWith("ssh://") ? projectRoot : path.resolve(projectRoot),
    );
  }

  /** Resolve a file path or extension to servers in layer priority order. */
  resolve(file: string): ResolvedServer[] {
    return this.candidates(file).filter(
      (match) =>
        !match.config.requireRootMarker || this.hasRootMarker(file, match.config.rootMarkers),
    );
  }

  private candidates(file: string): ResolvedServer[] {
    const basename = path.basename(file);
    const extension = path.extname(file) || (file.startsWith(".") ? file : `.${file}`);
    const normalizeName = (name: string) =>
      process.platform === "win32" ? name.toLowerCase() : name;
    const matches: ResolvedServer[] = [];
    for (const entry of this._entries) {
      if (!this._servers[entry.id]) continue;

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

  /** Resolve remote candidates using only their owner's marker checks. */
  async resolveOwned(
    file: string,
    exists: (source: string) => Promise<boolean>,
  ): Promise<ResolvedServer[]> {
    if (!this._projectRoot.startsWith("ssh://")) return this.resolve(file);
    const root = new URL(this._projectRoot);
    const rootPath = decodeURIComponent(root.pathname);
    const extensionOnly = file.startsWith(".") && !file.includes("/");
    const selected = file.includes("://") ? new URL(file) : new URL(root.href);
    const filePath = file.includes("://")
      ? decodeURIComponent(selected.pathname)
      : path.posix.resolve(rootPath, file);
    const relative = path.posix.relative(rootPath, filePath);
    if (
      selected.origin !== root.origin ||
      selected.host !== root.host ||
      selected.protocol !== root.protocol ||
      selected.username ||
      selected.password ||
      selected.port ||
      selected.search ||
      selected.hash ||
      // Containment checks reject parent traversal; they do not construct paths.
      // eslint-disable-next-line repo/no-parent-paths
      relative === ".." ||
      // eslint-disable-next-line repo/no-parent-paths
      relative.startsWith("../")
    )
      throw Object.assign(new Error("Language server resource belongs to another owner"), {
        code: "UNSUPPORTED_SOURCE",
      });
    const matches: ResolvedServer[] = [];
    for (const candidate of this.candidates(extensionOnly ? file : filePath)) {
      if (!candidate.config.requireRootMarker) {
        matches.push(candidate);
        continue;
      }
      let directory =
        extensionOnly || filePath === rootPath ? rootPath : path.posix.dirname(filePath);
      for (;;) {
        let found = false;
        for (const marker of candidate.config.rootMarkers) {
          const markerPath = path.posix.resolve(directory, marker);
          const markerRelative = path.posix.relative(rootPath, markerPath);
          // Marker containment only; no parent-relative path is constructed.
          // eslint-disable-next-line repo/no-parent-paths
          if (markerRelative === ".." || markerRelative.startsWith("../")) continue;
          const uri = new URL(root.href);
          uri.pathname = markerPath.split("/").map(encodeURIComponent).join("/");
          if (await exists(uri.href)) {
            found = true;
            break;
          }
        }
        if (found) {
          matches.push(candidate);
          break;
        }
        if (directory === rootPath) break;
        directory = path.posix.dirname(directory);
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

  /** Canonical workspace used for marker resolution and remote document synchronization. */
  get projectRoot(): string {
    return this._projectRoot;
  }

  /** All effective server configurations by stable ID. */
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
    const file = extension.startsWith("ssh://")
      ? decodeURIComponent(new URL(extension).pathname)
      : extension;
    const resolved = this._projectRoot.startsWith("ssh://")
      ? this.candidates(file)
      : this.resolve(file);
    return resolved[0]?.languageId ?? extension.slice(1);
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
