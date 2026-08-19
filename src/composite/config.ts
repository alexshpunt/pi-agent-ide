import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** User configuration for the unified Pi Agent IDE extension. */
export interface PiAgentIdeConfig
{
    readonly disabledExtensions: readonly string[];
}

/** Resolves the global Pi Agent IDE configuration file. */
export function resolvePiAgentIdeConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string
{
    const configured = env.PI_AGENT_IDE_CONFIG?.trim();
    if (configured !== undefined && configured.length > 0)
    {
        return path.resolve(configured);
    }

    const agentDirectory = env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDirectory, ".pi", "agent");
    return path.join(agentDirectory, "pi-agent-ide.json");
}

/** Reads the configuration file, defaulting to all built-ins enabled when it is absent. */
export async function readPiAgentIdeConfig(configPath: string): Promise<PiAgentIdeConfig>
{
    let source: string;

    try
    {
        source = await readFile(configPath, "utf8");
    }
    catch (error)
    {
        if (isMissingFile(error))
        {
            return { disabledExtensions: [] };
        }

        throw new Error(`Cannot read Pi Agent IDE config at ${configPath}: ${errorMessage(error)}`);
    }

    let value: unknown;

    try
    {
        value = JSON.parse(source);
    }
    catch (error)
    {
        throw new Error(`Invalid JSON in Pi Agent IDE config at ${configPath}: ${errorMessage(error)}`);
    }

    if (!isRecord(value))
    {
        throw new Error(`Pi Agent IDE config at ${configPath} must be a JSON object`);
    }

    const disabled = value.disabledExtensions;
    if (disabled === undefined)
    {
        return { disabledExtensions: [] };
    }
    if (!Array.isArray(disabled) || disabled.some((id) => typeof id !== "string" || id.length === 0))
    {
        throw new Error(`disabledExtensions in ${configPath} must be an array of non-empty strings`);
    }

    const unique = new Set(disabled);
    if (unique.size !== disabled.length)
    {
        throw new Error(`disabledExtensions in ${configPath} must not contain duplicate IDs`);
    }

    return { disabledExtensions: disabled };
}

function isMissingFile(error: unknown): boolean
{
    return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}
