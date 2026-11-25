import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const githubPackageRoot = dirname(fileURLToPath(import.meta.resolve("#github-package")));
