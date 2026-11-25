import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

async function configuredPath(file: string, base: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("LINEAR_CONFIG_FAILED", { cause: error });
  }
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error("LINEAR_CONFIG_FAILED");
  }
  if (
    !config ||
    typeof config !== "object" ||
    !("axiPath" in config) ||
    typeof config.axiPath !== "string" ||
    !config.axiPath.trim()
  ) {
    throw new Error("LINEAR_CONFIG_FAILED");
  }
  return path.isAbsolute(config.axiPath) || config.axiPath === "linear-axi"
    ? config.axiPath
    : path.resolve(base, config.axiPath);
}

/** Explicit project/global overrides win; otherwise use our installed backend package. */
export async function axiPath(cwd: string): Promise<string> {
  const local = await configuredPath(path.join(cwd, ".pi", "linear.json"), cwd);
  if (local !== undefined) return local;
  const agentDir = getAgentDir();
  return (
    (await configuredPath(path.join(agentDir, "linear.json"), agentDir)) ??
    require.resolve("@nikolauska/linear-axi/dist/bin.js")
  );
}
