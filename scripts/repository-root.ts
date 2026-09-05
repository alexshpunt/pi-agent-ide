import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Finds the repository root by walking up from startUrl until a directory
 * containing pnpm-workspace.yaml. Throws when no repository root is found.
 */
export function findRepositoryRoot(startUrl: string | URL): string {
  let directory = dirname(fileURLToPath(startUrl));
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Repository root with pnpm-workspace.yaml not found above ${directory}`);
    }
    directory = parent;
  }
}
