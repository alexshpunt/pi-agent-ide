#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Scans every tracked repository file for paths that traverse up with a
 * dot-dot segment. Absolute, root-relative, and downward-relative paths are
 * allowed. Exits 1 when any traversal is found.
 *
 * JavaScript-family files are skipped: the oxlint rule repo/no-parent-paths
 * owns them.
 */

const ignoredFiles = new Set(["pnpm-lock.yaml"]);
const ignoredNameSegments = new Set(["__fixtures__", "fixtures", ".tmp"]);
const lintedExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts"]);

/** Matches a dot-dot path segment: at the start of a path, after a separator, or as a bare quoted string. */
const parentSegment = /(?<!\.)\.\.\/|(?<!\.)\/\.\.(?![.\w])|['"`]\.\.['"`]/u;

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => !isIgnored(file));

const failures: string[] = [];

for (const file of files) {
  let content: string;

  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  if (content.includes("\0")) continue;

  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (parentSegment.test(line)) {
      failures.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Checked ${files.length} repository files for parent-traversal paths.\n`);

function isIgnored(file: string): boolean {
  if (ignoredFiles.has(file)) return true;
  if (file.startsWith(".agents/") || file.startsWith(".pi/")) return true;
  if (lintedExtensions.has(file.slice(file.lastIndexOf(".")))) return true;
  const segments = file.split("/");
  return segments.some((segment) => ignoredNameSegments.has(segment));
}
