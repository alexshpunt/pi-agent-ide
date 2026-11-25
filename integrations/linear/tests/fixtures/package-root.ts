import path from "node:path";
import { fileURLToPath } from "node:url";

export const linearPackageRoot = path.dirname(fileURLToPath(import.meta.resolve("#linear-package")));
