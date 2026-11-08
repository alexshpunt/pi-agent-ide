#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

/**
 * Local imports of TypeScript files name the `.ts` file. A `.js` specifier for a `.ts` file
 * makes Pi's extension loader (jiti) try the missing `.js` path first for every import, which
 * made loading pi-agent-ide from sources about twice as slow.
 */
const root = findRepositoryRoot(import.meta.url);
const scanned = ["src", "packages", "tests", "scripts", "benchmarks"].map((directory) =>
  path.join(root, directory),
);
const manifests = new Map<string, Record<string, unknown> | null>();
const violations: string[] = [];
let files = 0;

for (const file of collectTypeScriptFiles(scanned)) {
  files += 1;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bexport\s*\*\s*from\s*)(["'])([^"']+)\.js\1/gu,
  )) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    const target = resolveLocal(specifier, file);
    if (target !== undefined && existsSync(`${target}.ts`)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(
        `${path.relative(root, file)}:${line} imports ${specifier}.js; use ${specifier}.ts`,
      );
    }
  }
}

if (violations.length > 0) {
  throw new Error(`Imports of TypeScript files must use .ts:\n${violations.join("\n")}`);
}
console.log(`Checked import extensions in ${files} TypeScript files.`);

/** The file a relative or package-`imports` specifier names, without its extension. */
function resolveLocal(specifier: string, file: string): string | undefined {
  // oxlint-disable-next-line repo/no-parent-paths -- matches relative specifiers, not a traversal
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return path.resolve(path.dirname(file), specifier);
  if (!specifier.startsWith("#")) return undefined;
  const owner = nearestImports(path.dirname(file));
  if (owner === undefined) return undefined;
  for (const [key, value] of Object.entries(owner.imports)) {
    const target =
      typeof value === "string"
        ? value
        : value !== null && typeof value === "object" && "default" in value
          ? value.default
          : undefined;
    if (typeof target !== "string" || !key.endsWith("*")) continue;
    const prefix = key.slice(0, -1);
    if (specifier.startsWith(prefix))
      return path.join(owner.directory, target.replace("*", specifier.slice(prefix.length)));
  }
  return undefined;
}

/** The package `imports` map that applies to a directory: the nearest package.json's. */
function nearestImports(
  directory: string,
): { directory: string; imports: Record<string, unknown> } | undefined {
  for (let current = directory; current.startsWith(root); current = path.dirname(current)) {
    const manifestPath = path.join(current, "package.json");
    let manifest = manifests.get(manifestPath);
    if (manifest === undefined) {
      manifest = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
        : null;
      manifests.set(manifestPath, manifest);
    }
    if (manifest === null) continue;
    const imports = manifest.imports;
    return imports !== null && typeof imports === "object"
      ? { directory: current, imports: imports as Record<string, unknown> }
      : undefined;
  }
  return undefined;
}

function collectTypeScriptFiles(directories: readonly string[]): string[] {
  const found: string[] = [];
  const pending = [...directories];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const target = path.join(directory, entry);
      if (statSync(target).isDirectory()) pending.push(target);
      else if (target.endsWith(".ts") && !target.endsWith(".d.ts")) found.push(target);
    }
  }
  return found;
}
