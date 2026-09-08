import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve Pi's bundled ripgrep binary, falling back to the system PATH. */
export function resolveRipgrepExecutable(
  agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  platform: NodeJS.Platform = process.platform,
): string {
  const bundledExecutable = path.join(
    agentDirectory,
    "bin",
    platform === "win32" ? "rg.exe" : "rg",
  );
  return existsSync(bundledExecutable) ? bundledExecutable : "rg";
}
