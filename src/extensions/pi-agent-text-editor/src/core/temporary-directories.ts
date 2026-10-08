import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface TemporaryDirectorySettings {
  readonly mode: "replace" | "extend";
  readonly paths: readonly string[];
}

/** Load temporary roots for Delete: defaults, then global, then project settings. */
export async function loadTemporaryDirectories(projectRoot: string): Promise<readonly string[]> {
  const home = await realpath(os.homedir());
  const agent = process.env.PI_CODING_AGENT_DIR?.trim();
  const names = ["tmp", ".tmp", "temp", ".temp"];
  const system = await existingRoot(os.tmpdir());
  // Named defaults do not grant permission to a symlink's destination outside the root.
  let roots = [
    ...names.map((name) => path.join(projectRoot, name)),
    ...names.map((name) => path.join(home, name)),
    ...(system === undefined ? [] : [system]),
  ];
  const layers = [
    {
      file: path.join(
        agent ? path.resolve(agent) : path.join(home, ".pi", "agent"),
        "pi-agent-ide",
        "deletion.json",
      ),
      base: home,
    },
    { file: path.join(projectRoot, ".pi", "pi-agent-ide", "deletion.json"), base: projectRoot },
  ];
  for (const { file, base } of layers) {
    const settings = await readSettings(file);
    if (settings === undefined) continue;
    const configured: string[] = [];
    for (const entry of settings.paths) {
      const expanded =
        entry === "~"
          ? home
          : entry.startsWith("~/")
            ? path.join(home, entry.slice(2))
            : path.resolve(base, entry);
      const root = await existingRoot(expanded);
      if (root !== undefined) configured.push(root);
    }
    roots = settings.mode === "replace" ? configured : [...roots, ...configured];
  }
  return [...new Set(roots)].sort();
}

async function readSettings(file: string): Promise<TemporaryDirectorySettings | undefined> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in deletion config at ${file}`, { cause: error });
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "temporaryDirectories"))
    throw new Error(`Invalid deletion config at ${file}: expected temporaryDirectories settings`);
  if (value.temporaryDirectories === undefined) return undefined;
  const settings = value.temporaryDirectories;
  if (
    !isRecord(settings) ||
    Object.keys(settings).some((key) => key !== "mode" && key !== "paths") ||
    (settings.mode !== "replace" && settings.mode !== "extend") ||
    !Array.isArray(settings.paths) ||
    settings.paths.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  )
    throw new Error(
      `Invalid temporaryDirectories at ${file}: use mode replace or extend and a paths array of non-empty strings`,
    );
  return { mode: settings.mode, paths: settings.paths as string[] };
}

async function existingRoot(directory: string): Promise<string | undefined> {
  try {
    return await realpath(directory);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
