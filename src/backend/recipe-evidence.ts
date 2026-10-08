import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolRecipe } from "pi-agent-doctor/api/catalog";
import { inspectRecipeEvidence, type RecipeEvidence } from "pi-agent-doctor/api/evidence";
import type { SshBackend } from "./ssh.js";
import { SshBackendError } from "./ssh.js";

const snapshotSchema = Type.Object({
  content: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
  markers: Type.Record(Type.String(), Type.Boolean()),
  names: Type.Array(Type.String()),
});

/** Inspect native evidence in one owned request, using the shared recipe scoring rules. */
export async function inspectSshRecipeEvidence(
  backend: SshBackend,
  cwd: string,
  recipes: readonly ToolRecipe[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, RecipeEvidence>> {
  signal?.throwIfAborted();
  const files = [
    ...new Set([
      "package.json",
      ...recipes.flatMap((recipe) => Object.keys(recipe.configSections ?? {})),
    ]),
  ];
  const markers = [...new Set(recipes.flatMap((recipe) => recipe.configFiles ?? []))];
  for (const name of [...files, ...markers]) {
    const relative = path.posix.relative(cwd, path.posix.resolve(cwd, name));
    // Containment validation does not construct a parent-relative path.
    // eslint-disable-next-line repo/no-parent-paths
    if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(name))
      throw new SshBackendError("UNSUPPORTED_SOURCE", cwd, "not-applied");
  }
  const script = await readFile(new URL("./recipe-evidence-worker.py", import.meta.url), {
    encoding: "utf8",
    signal,
  });
  const result = await backend.execute(
    "python3",
    [
      "-c",
      script,
      cwd,
      JSON.stringify({
        files,
        markers: markers.filter((marker) => !marker.includes("*")),
        listNames: markers.some((marker) => marker.includes("*")),
      }),
    ],
    cwd,
    { signal },
  );
  if (result.exitCode !== 0) throw new SshBackendError("EVIDENCE_FAILED", cwd, "not-applied");
  const snapshot: unknown = JSON.parse(result.stdout.toString("utf8"));
  if (Value.Check(Type.Object({ error: Type.Literal("CONTENT_LIMIT") }), snapshot))
    throw new SshBackendError("CONTENT_LIMIT", cwd, "not-applied");
  if (!Value.Check(snapshotSchema, snapshot))
    throw new SshBackendError("INVALID_RESPONSE", cwd, "not-applied");
  return inspectRecipeEvidence(
    cwd,
    recipes,
    {
      readText: (file) => Promise.resolve(snapshot.content[file] ?? undefined),
      hasMarker: (marker) =>
        Promise.resolve(
          marker.includes("*")
            ? snapshot.names.some((name) => path.matchesGlob(name, marker))
            : snapshot.markers[marker] === true,
        ),
    },
    signal,
  );
}
