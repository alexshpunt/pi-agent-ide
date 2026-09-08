import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const defaultSearchTimeoutMs = 30_000;

/** Paths used to resolve global and project search settings. */
export interface SearchConfigPaths {
  readonly globalPath: string;
  readonly projectPath: string;
}

/** Effective search settings after applying global and project configuration. */
export interface SearchConfig {
  readonly timeoutMs: number | null;
}

/** Resolve global and project `pi-agent-ide/search.json` files. */
export function resolveSearchConfigPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
  workingDirectory: string = process.cwd(),
): SearchConfigPaths {
  const configuredAgentDirectory = environment.PI_CODING_AGENT_DIR?.trim();
  const agentDirectory =
    configuredAgentDirectory === undefined || configuredAgentDirectory.length === 0
      ? path.join(homeDirectory, ".pi", "agent")
      : path.resolve(configuredAgentDirectory);

  return {
    globalPath: path.join(agentDirectory, "pi-agent-ide", "search.json"),
    projectPath: path.resolve(workingDirectory, ".pi", "pi-agent-ide", "search.json"),
  };
}

/** Load search settings, with project values overriding global values. */
export async function loadSearchConfig(paths: SearchConfigPaths): Promise<SearchConfig> {
  const [globalTimeoutMs, projectTimeoutMs] = await Promise.all([
    readTimeout(paths.globalPath),
    readTimeout(paths.projectPath),
  ]);

  const configuredTimeoutMs = projectTimeoutMs !== undefined ? projectTimeoutMs : globalTimeoutMs;
  return {
    timeoutMs: configuredTimeoutMs === undefined ? defaultSearchTimeoutMs : configuredTimeoutMs,
  };
}

async function readTimeout(configPath: string): Promise<number | null | undefined> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw new Error(`Cannot read Pi Agent IDE search config at ${configPath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in Pi Agent IDE search config at ${configPath}`, {
      cause: error,
    });
  }

  if (!isRecord(value)) {
    throw new TypeError(`Pi Agent IDE search config at ${configPath} must be a JSON object`);
  }

  const unknownKey = Object.keys(value).find((key) => key !== "timeoutMs");
  if (unknownKey !== undefined) {
    throw new TypeError(
      `Pi Agent IDE search config at ${configPath} contains unknown key ${unknownKey}`,
    );
  }

  const timeoutMs = value.timeoutMs;
  if (timeoutMs === undefined || timeoutMs === null) {
    return timeoutMs;
  }
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `timeoutMs must be a positive integer or null in Pi Agent IDE search config at ${configPath}`,
    );
  }
  return timeoutMs;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
