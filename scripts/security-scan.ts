#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const repositoryRoot = findRepositoryRoot(import.meta.url);
const configPath = path.join(repositoryRoot, ".gitleaks.toml");
const scannerPath = fileURLToPath(import.meta.url);
const gitleaksVersion = "8.30.1";
const gitleaksLinuxX64Sha256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";
const hygieneRules = [
  { label: "local npm registry", pattern: /(?:localhost|127\.0\.0\.1):4873/u },
  { label: "development package version", pattern: /0\.0\.0-dev\./u },
  {
    label: "absolute local dependency",
    pattern: /(?:file|link):(?:\/|[A-Za-z]:\\\\)/u,
    dependencyMetadataOnly: true,
  },
  { label: "private package override", pattern: /@alexshp\/pi-coding-agent-(?:test|eval)/u },
  { label: "root machine path", pattern: /\/root\/(?:dev|\.pi)\//u },
] as const;

/** Returns the pinned, checksum-verified Gitleaks executable. */
export function ensureGitleaks(): string {
  invariant(
    process.platform === "linux" && process.arch === "x64",
    "Pinned Gitleaks download supports linux-x64 only",
  );
  const directory = path.join(repositoryRoot, ".agents/tmp/tools", `gitleaks-${gitleaksVersion}`);
  const executable = path.join(directory, "gitleaks");
  if (existsSync(executable)) return executable;

  mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, "gitleaks.tar.gz");
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/gitleaks_${gitleaksVersion}_linux_x64.tar.gz`;
  run("curl", ["--fail", "--location", "--silent", "--show-error", "--output", archive, url]);
  invariant(hashFile(archive) === gitleaksLinuxX64Sha256, "Gitleaks archive checksum mismatch");
  run("tar", ["-xzf", archive, "-C", directory, "gitleaks"]);
  rmSync(archive);
  return executable;
}

/** Scans files for release-hygiene violations that are not credentials. */
export function scanReleaseHygiene(files: readonly string[]): void {
  const findings: string[] = [];
  for (const file of files) {
    if (
      path.resolve(file) === scannerPath ||
      file.replaceAll("\\", "/").endsWith("/scripts/security-scan.ts")
    )
      continue;
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const rule of hygieneRules) {
      if ("dependencyMetadataOnly" in rule && !isDependencyMetadata(file)) continue;
      if (rule.pattern.test(text)) findings.push(`${file}: ${rule.label}`);
    }
  }
  invariant(findings.length === 0, `Release hygiene violations:\n${findings.join("\n")}`);
}

function isDependencyMetadata(file: string): boolean {
  const name = path.basename(file);
  return name === "package.json" || name === "pnpm-lock.yaml" || name === "pnpm-workspace.yaml";
}

function run(command: string, args: readonly string[], cwd = repositoryRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  invariant(result.status === 0, `${command} failed with exit code ${String(result.status)}`);
}

function output(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  invariant(result.status === 0, `${command} failed with exit code ${String(result.status)}`);
  return result.stdout.trim();
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agents")
      continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function scanArtifact(archive: string, gitleaks: string): void {
  const absoluteArchive = path.resolve(archive);
  invariant(existsSync(absoluteArchive), `Missing artifact ${absoluteArchive}`);
  const entries = output("tar", ["-tzf", absoluteArchive]).split("\n");
  invariant(
    entries.every((entry) => entry === "package/" || entry.startsWith("package/")),
    "Artifact contains a path outside package/",
  );
  invariant(
    // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
    entries.every((entry) => !entry.split("/").includes("..")),
    "Artifact contains path traversal",
  );
  const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-agent-ide-artifact-scan-"));
  try {
    run("tar", ["-xzf", absoluteArchive, "-C", temporary]);
    run(gitleaks, ["dir", "--redact", "--config", configPath, temporary]);
    scanReleaseHygiene(walk(temporary));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--") arguments_.shift();
  const [mode] = arguments_;
  invariant(mode !== undefined, "Usage: security-scan.ts staged|range|history|tree|artifact");
  const gitleaks = ensureGitleaks();
  if (mode === "staged") {
    run(gitleaks, ["git", "--staged", "--redact", "--config", configPath, repositoryRoot]);
    return;
  }
  if (mode === "range") {
    const base = arguments_[1];
    const head = arguments_[2];
    invariant(base !== undefined && head !== undefined, "range requires <base> <head>");
    run(gitleaks, [
      "git",
      "--redact",
      "--config",
      configPath,
      `--log-opts=${base}..${head}`,
      repositoryRoot,
    ]);
    return;
  }
  if (mode === "history") {
    run(gitleaks, ["git", "--redact", "--config", configPath, "--log-opts=HEAD", repositoryRoot]);
    return;
  }
  if (mode === "tree") {
    const directory = arguments_[1];
    invariant(directory !== undefined, "tree requires <directory>");
    const absolute = path.resolve(directory);
    run(gitleaks, ["dir", "--redact", "--config", configPath, absolute]);
    scanReleaseHygiene(walk(absolute));
    return;
  }
  if (mode === "artifact") {
    const archive = arguments_[1];
    invariant(archive !== undefined, "artifact requires <tarball>");
    scanArtifact(archive, gitleaks);
    return;
  }
  throw new Error(`Unknown security scan mode: ${mode}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
