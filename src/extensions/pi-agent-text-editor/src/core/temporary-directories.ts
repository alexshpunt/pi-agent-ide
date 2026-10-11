import path from "node:path";
import type { DeleteFileAccess } from "#src/api/delete-guard.js";
import { localFileTransferAccess as localFiles } from "#src/api/native-files.js";

const temporaryNames = new Set(["tmp", ".tmp", "temp", ".temp"]);

interface TemporaryDirectorySettings {
  readonly mode: "replace" | "extend";
  readonly paths: readonly string[];
}

/** Load temporary removal roots for a resolved path, then apply its owner's settings.
 * A provider without native account defaults keeps the strict removal policy.
 */
export async function loadTemporaryDirectories(
  projectRoot: string,
  resolvedPath: string,
  files: DeleteFileAccess = localFiles,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  if (files.temporaryEnvironment === undefined) return [];
  const environment = await files.temporaryEnvironment(signal);
  const paths = files.pathStyle === "native" ? path : path.posix;
  const home = await files.realpath(environment.home);
  const system = await existingRoot(environment.temporary, files, signal);
  let roots = system === undefined ? [] : [system];
  // The caller has resolved parent links; only real path components grant the default exception.
  for (let directory = resolvedPath; ;) {
    if (temporaryNames.has(paths.basename(directory))) roots.push(directory);
    const parent = paths.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const layers = [
    {
      file: paths.join(
        environment.agentDirectory ?? paths.join(home, ".pi", "agent"),
        "pi-agent-ide",
        "deletion.json",
      ),
      base: home,
    },
    { file: paths.join(projectRoot, ".pi", "pi-agent-ide", "deletion.json"), base: projectRoot },
  ];
  for (const { file, base } of layers) {
    const settings = await readSettings(file, files, signal);
    if (settings === undefined) continue;
    const configured: string[] = [];
    for (const entry of settings.paths) {
      const expanded =
        entry === "~"
          ? home
          : entry.startsWith("~/")
            ? paths.join(home, entry.slice(2))
            : paths.resolve(base, entry);
      const root = await existingRoot(expanded, files, signal);
      if (root !== undefined) configured.push(root);
    }
    roots = settings.mode === "replace" ? configured : [...roots, ...configured];
  }
  signal?.throwIfAborted();
  return [...new Set(roots)].sort();
}

async function readSettings(
  file: string,
  files: DeleteFileAccess,
  signal?: AbortSignal,
): Promise<TemporaryDirectorySettings | undefined> {
  signal?.throwIfAborted();
  let source: string;
  try {
    source = await files.read(file);
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

async function existingRoot(
  directory: string,
  files: DeleteFileAccess,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    return await files.realpath(directory);
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
