import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_MCP_URL = "https://mcp.linear.app/mcp";

/** Load shared Linear values while preserving explicit process values. */
export async function loadDotEnv(env: NodeJS.ProcessEnv, cwd: string): Promise<NodeJS.ProcessEnv> {
  const configuredPath = env.LINEAR_AXI_ENV_FILE;
  const path = configuredPath
    ? isAbsolute(configuredPath)
      ? configuredPath
      : resolve(cwd, configuredPath)
    : join(piAgentDir(env), "config", "linear-axi", ".env");

  if (!(await fileExists(path))) {
    if (configuredPath) throw new Error(`Linear environment file was not found: ${path}`);
    return { ...env };
  }

  const values = parseDotEnv(await readFile(path, "utf8"));
  return { ...values, ...env };
}

/** Resolve the Pi agent directory used for shared Linear configuration. */
export function piAgentDir(env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Parse simple dotenv assignments without expanding or logging secret values. */
export function parseDotEnv(text: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]] = parseDotEnvValue(match[2]);
  }
  return values;
}

export async function resolveMcpUrl(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.LINEAR_AXI_MCP_URL) {
    return env.LINEAR_AXI_MCP_URL;
  }

  const configPath = env.CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");
  try {
    const text = await readFile(configPath, "utf8");
    return extractLinearMcpUrl(text) ?? DEFAULT_MCP_URL;
  } catch {
    return DEFAULT_MCP_URL;
  }
}

export function extractLinearMcpUrl(text: string): string | null {
  let inLinearTable = false;

  for (const line of text.split(/\r?\n/)) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      inLinearTable = table[1].trim() === "mcp_servers.linear";
      continue;
    }

    if (!inLinearTable) continue;
    const url = line.match(/^\s*url\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/);
    if (url) return url[2];
  }

  return null;
}

export function collapseHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const end = findClosingQuote(trimmed, '"');
    if (end !== -1) {
      return trimmed
        .slice(1, end)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    if (end !== -1) return trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index++) {
    if (value[index] !== quote || value[index - 1] === "\\") continue;
    return index;
  }
  return -1;
}
