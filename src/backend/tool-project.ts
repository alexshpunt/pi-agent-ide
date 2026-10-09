import path from "node:path";
import type { ToolRecipe } from "pi-agent-doctor/api/catalog";
import { recipeMatchesFile, type ToolConfigName } from "#src/api/tool-config.js";
import type { SshBackend } from "./ssh.js";
import { SshBackendError } from "./ssh.js";
import { remoteLocation } from "./identity.js";
import { inspectSshRecipeEvidence } from "./recipe-evidence.js";

/** Resolve an SSH file or directory's native project; an explicit current project keeps its context. */
export async function resolveSshToolProject(
  backend: SshBackend,
  filePath: string,
  currentRoot: string | undefined,
  name: ToolConfigName,
  recipes: readonly ToolRecipe[],
  signal?: AbortSignal,
): Promise<{ cwd: string; external: boolean } | undefined> {
  signal?.throwIfAborted();
  const file = remoteLocation(backend.target.id, filePath).path;
  if (currentRoot && inside(currentRoot, file))
    return { cwd: remoteLocation(backend.target.id, currentRoot).source, external: false };
  let selectedDirectory = false;
  try {
    selectedDirectory = (await backend.stat(file, { signal })).kind === "directory";
  } catch (error) {
    if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
  }
  const relevant = selectedDirectory
    ? recipes
    : recipes.filter((recipe) => recipeMatchesFile(recipe, file));
  const fallback =
    currentRoot === undefined && inside(backend.target.workspace, file)
      ? backend.target.workspace
      : undefined;
  let directory = selectedDirectory ? file : path.posix.dirname(file);
  for (;;) {
    signal?.throwIfAborted();
    const config = path.posix.join(directory, ".pi", "pi-agent-ide", `${name}.json`);
    let configured = false;
    try {
      await backend.stat(config, { signal });
      configured = true;
    } catch (error) {
      if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
    }
    const evidenced =
      !configured && relevant.length > 0
        ? [...(await inspectSshRecipeEvidence(backend, directory, relevant, signal)).values()].some(
            (item) => item.score > 0,
          )
        : false;
    if (configured || evidenced || directory === fallback)
      return {
        cwd: remoteLocation(backend.target.id, directory).source,
        external: currentRoot !== undefined,
      };
    const parent = path.posix.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function inside(root: string, file: string): boolean {
  const relative = path.posix.relative(root, file);
  return (
    relative === "" ||
    // Containment only; no parent-relative path is constructed.
    // eslint-disable-next-line repo/no-parent-paths
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
  );
}
