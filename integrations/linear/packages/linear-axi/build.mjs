import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("./", import.meta.url));
const dist = path.join(root, "dist");
const scratch = await mkdtemp(path.join(root, ".tmp-axi-build-"));

try {
  // Bundle private source aliases so the installed backend needs only its runtime dependencies.
  await build({
    absWorkingDir: root,
    entryPoints: ["src/bin.ts", "src/worker.ts"],
    outdir: scratch,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["#axi-package"],
  });
  await mkdir(dist, { recursive: true });
  for (const entry of ["bin.js", "worker.js"]) {
    await rename(path.join(scratch, entry), path.join(dist, entry));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
