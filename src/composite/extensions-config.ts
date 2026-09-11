import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Paths used to resolve Pi Agent IDE extension settings.
 */
export interface PiAgentIdeExtensionsConfigPaths {
  readonly globalPath: string;
  readonly projectPath: string;
}

/**
 * Extension settings loaded from the project and global config files.
 */
export interface PiAgentIdeExtensionsConfig {
  readonly disabled: readonly string[];
  readonly enabled: readonly string[];
  /** Boolean flag overrides keyed by their registered flag IDs. */
  readonly flags?: Readonly<Record<string, boolean>>;
  /** String preference overrides keyed by their registered IDs. */
  readonly preferences?: Readonly<Record<string, string>>;
  /** Disable decorative mutation playback while keeping final results visible. */
  readonly noAnimations?: boolean;
  /** Skip automatic formatting and diagnostics triggered by edits. */
  readonly noPostProcessing?: boolean;
}

/**
 * Resolves the project and global extension config files.
 */
export function resolvePiAgentIdeExtensionsConfigPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
  workingDirectory: string = process.cwd(),
): PiAgentIdeExtensionsConfigPaths {
  const configuredAgentDirectory = environment.PI_CODING_AGENT_DIR?.trim();
  const agentDirectory =
    configuredAgentDirectory === undefined || configuredAgentDirectory.length === 0
      ? path.join(homeDirectory, ".pi", "agent")
      : path.resolve(configuredAgentDirectory);

  return {
    globalPath: path.join(agentDirectory, "pi-agent-ide", "extensions.json"),
    projectPath: path.resolve(workingDirectory, ".pi", "pi-agent-ide", "extensions.json"),
  };
}

/**
 * Reads both extension config files and merges their disabled and enabled IDs.
 *
 * A missing file leaves the built-in defaults in place: every extension on unless a
 * catalog entry marks it off by default. If either file disables an ID, that ID stays
 * disabled; `enabled` only turns on extensions that are off by default.
 */
export async function readPiAgentIdeExtensionsConfig(
  paths: PiAgentIdeExtensionsConfigPaths,
): Promise<PiAgentIdeExtensionsConfig> {
  const globalConfig = await readConfigExtensionIds(paths.globalPath);
  const projectConfig = await readConfigExtensionIds(paths.projectPath);

  return {
    disabled: [...new Set([...globalConfig.disabled, ...projectConfig.disabled])],
    enabled: [...new Set([...globalConfig.enabled, ...projectConfig.enabled])],
    ...(globalConfig.flags === undefined && projectConfig.flags === undefined
      ? {}
      : {
          flags: {
            ...configuredFeatureFlags(globalConfig),
            ...configuredFeatureFlags(projectConfig),
          },
        }),
    ...(globalConfig.preferences === undefined && projectConfig.preferences === undefined
      ? {}
      : { preferences: { ...globalConfig.preferences, ...projectConfig.preferences } }),
    noAnimations: projectConfig.noAnimations ?? globalConfig.noAnimations ?? false,
    noPostProcessing: projectConfig.noPostProcessing ?? globalConfig.noPostProcessing ?? false,
  };
}

/** Resolve feature values in one scope, including existing top-level switches. */
export function configuredFeatureFlags(
  config: PiAgentIdeExtensionsConfig,
): Readonly<Record<string, boolean>> {
  return {
    ...(config.noAnimations === undefined
      ? {}
      : { "pi-agent-ide-no-animations": config.noAnimations }),
    ...(config.noPostProcessing === undefined
      ? {}
      : { "pi-agent-ide-no-post-processing": config.noPostProcessing }),
    ...config.flags,
  };
}
/** Read one settings scope using the same validation as startup. */
export async function readExtensionSettingsScope(
  configPath: string,
): Promise<PiAgentIdeExtensionsConfig> {
  return readConfigExtensionIds(configPath);
}
async function readConfigExtensionIds(configPath: string): Promise<PiAgentIdeExtensionsConfig> {
  let source: string;

  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { disabled: [], enabled: [] };
    }

    throw new Error(
      `Cannot read Pi Agent IDE extension config at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid JSON in Pi Agent IDE extension config at ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(value)) {
    throw new Error(`Pi Agent IDE extension config at ${configPath} must be a JSON object`);
  }

  return {
    disabled: readIdField(value, "disabled", configPath),
    enabled: readIdField(value, "enabled", configPath),
    ...(value.flags === undefined ? {} : { flags: readFlags(value.flags, configPath) }),
    ...(value.preferences === undefined
      ? {}
      : { preferences: readPreferences(value.preferences, configPath) }),
    ...(value.noAnimations === undefined
      ? {}
      : { noAnimations: readBoolean(value, "noAnimations", configPath) }),
    ...(value.noPostProcessing === undefined
      ? {}
      : { noPostProcessing: readBoolean(value, "noPostProcessing", configPath) }),
  };
}

function readPreferences(value: unknown, configPath: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`preferences in ${configPath} must be an object`);
  const preferences: Record<string, string> = {};
  for (const [id, setting] of Object.entries(value)) {
    if (typeof setting !== "string" || setting.length === 0)
      throw new Error(`Preference ${id} in ${configPath} must be a non-empty string`);
    preferences[id] = setting;
  }
  return preferences;
}
function readFlags(value: unknown, configPath: string): Record<string, boolean> {
  if (!isRecord(value)) throw new Error(`flags in ${configPath} must be an object`);
  const flags: Record<string, boolean> = {};
  for (const [id, setting] of Object.entries(value)) {
    if (typeof setting !== "boolean")
      throw new Error(`Flag ${id} in ${configPath} must be a boolean`);
    flags[id] = setting;
  }
  return flags;
}
function readBoolean(value: Record<string, unknown>, field: string, configPath: string): boolean {
  const setting = value[field];
  if (typeof setting !== "boolean") throw new Error(`${field} in ${configPath} must be a boolean`);
  return setting;
}

function readIdField(
  value: Record<string, unknown>,
  field: "disabled" | "enabled",
  configPath: string,
): readonly string[] {
  const ids = value[field];

  if (ids === undefined) {
    return [];
  }

  if (!Array.isArray(ids)) {
    throw new Error(`${field} in ${configPath} must be an array of non-empty strings`);
  }

  const stringIds = ids.filter((id): id is string => typeof id === "string");

  if (stringIds.length !== ids.length || stringIds.some((id) => id.length === 0)) {
    throw new Error(`${field} in ${configPath} must be an array of non-empty strings`);
  }

  const unique = new Set(stringIds);

  if (unique.size !== stringIds.length) {
    throw new Error(`${field} in ${configPath} must not contain duplicate IDs`);
  }

  return stringIds;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
