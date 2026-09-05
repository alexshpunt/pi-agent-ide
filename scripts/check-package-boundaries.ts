#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const root = findRepositoryRoot(import.meta.url);
const packageRoots = collectFiles(
  [path.join(root, "packages"), path.join(root, "src")],
  "package.json",
).map((file) => path.dirname(file));
const sourceFiles = collectSourceFiles([path.join(root, "packages"), path.join(root, "src")]);
const violations: string[] = [];

for (const file of sourceFiles) {
  let owner: string | undefined;
  for (const directory of packageRoots) {
    if (isWithin(file, directory) && (owner === undefined || directory.length > owner.length)) {
      owner = directory;
    }
  }
  if (owner === undefined) continue;

  for (const specifier of relativeSpecifiers(readFileSync(file, "utf8"))) {
    const target = path.resolve(path.dirname(file), specifier);
    if (!isWithin(target, owner)) {
      violations.push(
        `${path.relative(root, file)} imports ${specifier} outside ${path.relative(root, owner)}`,
      );
    }
  }
}

if (violations.length > 0) {
  throw new Error(`Workspace package boundary violations:\n${violations.join("\n")}`);
}

console.log(
  `Checked ${sourceFiles.length} source files across ${packageRoots.length} workspace packages.`,
);

function collectSourceFiles(directories: readonly string[]): string[] {
  return directories.flatMap((directory) =>
    collectFiles([directory], ".ts").filter(
      (file) => !file.includes(`${path.sep}node_modules${path.sep}`),
    ),
  );
}

function collectFiles(directories: readonly string[], suffix: string): string[] {
  const files: string[] = [];
  const pending = [...directories];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      const target = path.join(directory, entry);
      if (entry === "node_modules") continue;
      if (statSync(target).isDirectory()) pending.push(target);
      else if (target.endsWith(suffix)) files.push(target);
    }
  }
  return files;
}

function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\()(["'])(\.\.?\/[^"']+)\1/gu)].flatMap(
    (match) => (match[2] === undefined ? [] : [match[2]]),
  );
}

function isWithin(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
