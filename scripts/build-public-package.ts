#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

import { buildReleaseRuntime } from "#scripts/build-release-runtime.ts";

type StringRecord = Record<string, string>;

interface PackageManifest extends Record<string, unknown> {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: StringRecord;
  peerDependencies?: StringRecord;
  devDependencies?: StringRecord;
  scripts?: StringRecord;
  files?: string[];
  publishConfig?: Record<string, unknown>;
  imports?: unknown;
  exports?: unknown;
  bundledDependencies?: string[];
  pi?: { extensions?: string[] };
  workspaces?: string[];
}

interface InternalPackage {
  directory: string;
  manifest: PackageManifest;
  manifestPath: string;
}

interface CopyOptions {
  includeDocumentation?: boolean;
  stopAtPackageBoundaries?: boolean;
}

interface PackResult {
  filename: string;
  size: number;
  unpackedSize: number;
}

interface PackageReport {
  package: string;
  version: string;
  tarball: string;
  size: number;
  unpackedSize: number;
  files: number;
  bundledPackages: number;
  peerDependencies: StringRecord | undefined;
  topLevel: string[];
}

const repositoryRoot = findRepositoryRoot(import.meta.url);
const outputDirectory = join(repositoryRoot, ".agents", "tmp", "public-package");
const stageDirectory = join(outputDirectory, "stage");
const inspectionDirectory = join(outputDirectory, "inspection");
const gitRuntimeDirectory = parseGitRuntimeDirectory(process.argv.slice(2));

const piPeerNames = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);
const packageSearchRoots = [
  join(repositoryRoot, "packages"),
  join(repositoryRoot, "src", "extensions"),
  join(repositoryRoot, "src", "plugins"),
];
const forbiddenDirectoryNames = new Set([
  ".agents",
  ".git",
  ".tmp",
  ".vscode",
  "__tests__",
  "coverage",
  "dev",

  "node_modules",
  "test",
  "tests",
]);
const allowedTarballRoots = new Set([
  "CHANGELOG.md",
  "dist",
  "LICENSE",
  "README.md",
  "assets",
  "docs",
  "node_modules",
  "package.json",
  "src",
]);

const sourceManifest = readJson(join(repositoryRoot, "package.json"));
const releaseVersion = sourceManifest.version;
const internalPackages = discoverInternalPackages();
const internalNames = new Set(internalPackages.map((entry) => entry.manifest.name));
const packageDirectories = new Set(internalPackages.map((entry) => entry.directory));

assert(
  sourceManifest.name === "pi-agent-ide",
  `Expected pi-agent-ide, received ${sourceManifest.name}`,
);
assert(
  typeof releaseVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion),
  "Invalid package version",
);
assert(internalPackages.length > 0, "No internal packages were found");
assert(internalNames.size === internalPackages.length, "Internal package names must be unique");

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(stageDirectory, { recursive: true });

copyRequiredFile("README.md");
copyRequiredFile("CHANGELOG.md");
copyRequiredFile("LICENSE");
copyRuntimeTree(join(repositoryRoot, "assets"), join(stageDirectory, "assets"));
copyRuntimeTree(join(repositoryRoot, "docs"), join(stageDirectory, "docs"), {
  includeDocumentation: true,
});
copyRuntimeTree(join(repositoryRoot, "src"), join(stageDirectory, "src"));

for (const entry of internalPackages) {
  const bundledDirectory = join(stageDirectory, "node_modules", entry.manifest.name);
  copyRuntimeTree(entry.directory, bundledDirectory, { stopAtPackageBoundaries: true });
  writeJson(join(bundledDirectory, "package.json"), sanitizeInternalManifest(entry.manifest));

  const embeddedManifestPath = join(stageDirectory, relative(repositoryRoot, entry.manifestPath));
  if (existsSync(embeddedManifestPath)) {
    writeJson(embeddedManifestPath, sanitizeInternalManifest(entry.manifest));
  }
}

const releaseManifest = createReleaseManifest();
writeJson(join(stageDirectory, "package.json"), releaseManifest);

await buildReleaseRuntime(
  repositoryRoot,
  stageDirectory,
  internalPackages.map((entry) => ({
    source: entry.directory,
    targets: [
      join(stageDirectory, "node_modules", entry.manifest.name),
      join(stageDirectory, relative(repositoryRoot, entry.directory)),
    ],
  })),
);

const packOutput = execFileSync(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", outputDirectory],
  { cwd: stageDirectory, encoding: "utf8" },
);
const packResult = parsePackResult(packOutput);
const tarballPath = join(outputDirectory, packResult.filename);
assert(existsSync(tarballPath), `Missing tarball ${tarballPath}`);

mkdirSync(inspectionDirectory, { recursive: true });
execFileSync("tar", ["-xzf", tarballPath, "-C", inspectionDirectory]);
const extractedPackage = join(inspectionDirectory, "package");
const report = validatePackage(extractedPackage, packResult, tarballPath);
writeJson(join(outputDirectory, "report.json"), report);
if (gitRuntimeDirectory !== undefined) {
  await materializeGitRuntime(gitRuntimeDirectory, releaseManifest);
}

rmSync(stageDirectory, { recursive: true, force: true });
rmSync(inspectionDirectory, { recursive: true, force: true });

console.log(JSON.stringify(report, null, 2));

/** Finds the private workspace packages that must travel inside the umbrella tarball. */
function parseGitRuntimeDirectory(args: string[]): string | undefined {
  const index = args.indexOf("--git-runtime");
  if (index === -1) return undefined;
  const value = args[index + 1];
  assert(value !== undefined && value.length > 0, "--git-runtime requires a directory");
  return resolve(repositoryRoot, value);
}

/** Creates the npm-installable tree used by the Git preview ref. */
async function materializeGitRuntime(
  directory: string,
  releaseManifest: PackageManifest,
): Promise<void> {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  copyRequiredFile("README.md", directory);
  copyRequiredFile("CHANGELOG.md", directory);
  copyRequiredFile("LICENSE", directory);
  copyRuntimeTree(join(repositoryRoot, "assets"), join(directory, "assets"));
  copyRuntimeTree(join(repositoryRoot, "docs"), join(directory, "docs"), {
    includeDocumentation: true,
  });
  copyRuntimeTree(join(repositoryRoot, "packages"), join(directory, "packages"));
  copyRuntimeTree(join(repositoryRoot, "src"), join(directory, "src"));

  for (const entry of internalPackages) {
    const embeddedManifestPath = join(directory, relative(repositoryRoot, entry.manifestPath));
    assert(existsSync(embeddedManifestPath), `Missing runtime package ${entry.manifest.name}`);
    writeJson(embeddedManifestPath, sanitizeInternalManifest(entry.manifest));
  }

  const runtimeManifest = structuredClone(releaseManifest);
  delete runtimeManifest.bundledDependencies;
  delete runtimeManifest.publishConfig;
  runtimeManifest.workspaces = ["packages/*", "src/extensions/**", "src/plugins/*"];
  writeJson(join(directory, "package.json"), runtimeManifest);

  await buildReleaseRuntime(
    repositoryRoot,
    directory,
    internalPackages.map((entry) => ({
      source: entry.directory,
      targets: [join(directory, relative(repositoryRoot, entry.directory))],
    })),
  );
}

function discoverInternalPackages(): InternalPackage[] {
  const found: InternalPackage[] = [];
  for (const searchRoot of packageSearchRoots) {
    walk(searchRoot, (path) => {
      if (path.endsWith(`${sep}package.json`)) {
        const relativePath = toPosix(relative(repositoryRoot, path));
        if (isDevelopmentPath(relativePath)) return;
        const manifest = readJson(path);
        if (typeof manifest.name !== "string" || manifest.name === sourceManifest.name) return;
        found.push({
          directory: dirname(path),
          manifest,
          manifestPath: path,
        });
      }
    });
  }
  return found.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

/** Creates the manifest that will be visible in the public registry. */
function createReleaseManifest(): PackageManifest {
  const manifest = structuredClone(sourceManifest);
  delete manifest.private;
  delete manifest.devDependencies;
  delete manifest.scripts;

  manifest.files = ["src", "assets", "docs", "CHANGELOG.md", "LICENSE", "README.md"];
  manifest.publishConfig = { access: "public" };
  manifest.imports = filterPathMap(manifest.imports);
  manifest.exports = filterPathMap(manifest.exports);

  const dependencies = new Map<string, string>();
  for (const entry of internalPackages) {
    dependencies.set(entry.manifest.name, releaseVersion);
  }

  for (const owner of [sourceManifest, ...internalPackages.map((entry) => entry.manifest)]) {
    for (const [name, specifier] of Object.entries(owner.dependencies ?? {})) {
      if (piPeerNames.has(name) || name === sourceManifest.name || internalNames.has(name))
        continue;
      const existing = dependencies.get(name);
      if (existing !== undefined && existing !== specifier) {
        throw new Error(`Conflicting runtime ranges for ${name}: ${existing} and ${specifier}`);
      }
      dependencies.set(name, specifier);
    }
  }

  manifest.dependencies = Object.fromEntries(
    [...dependencies].sort(([left], [right]) => left.localeCompare(right)),
  );
  manifest.peerDependencies = Object.fromEntries(
    [...piPeerNames].sort().map((name) => [name, "*"]),
  );
  manifest.bundledDependencies = [...internalNames].sort();
  return manifest;
}

/** Removes development metadata and registry dependencies from a bundled package manifest. */
function sanitizeInternalManifest(source: PackageManifest): PackageManifest {
  const manifest = structuredClone(source);
  manifest.version = releaseVersion;
  delete manifest.private;
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest.publishConfig;
  delete manifest.files;

  const dependencies: StringRecord = {};
  const peerDependencies: StringRecord = {};
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (piPeerNames.has(name)) {
      peerDependencies[name] = "*";
    } else if (name === sourceManifest.name) {
      peerDependencies[name] = releaseVersion;
    } else if (internalNames.has(name)) {
      dependencies[name] = releaseVersion;
    } else {
      assert(
        !specifier.startsWith("workspace:"),
        `${manifest.name} has an external workspace dependency on ${name}`,
      );
      dependencies[name] = specifier;
    }
  }
  for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
    peerDependencies[name] = piPeerNames.has(name) ? "*" : specifier;
  }

  if (Object.keys(dependencies).length > 0) manifest.dependencies = sortRecord(dependencies);
  else delete manifest.dependencies;
  if (Object.keys(peerDependencies).length > 0)
    manifest.peerDependencies = sortRecord(peerDependencies);
  else delete manifest.peerDependencies;

  manifest.imports = filterPathMap(manifest.imports);
  manifest.exports = filterPathMap(manifest.exports);
  return manifest;
}

function filterPathMap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key, target]) => {
      const text = `${key} ${JSON.stringify(target)}`;
      return !/(^|[/#.-])tests?([/.-]|$)/i.test(text);
    }),
  );
}

function copyRequiredFile(relativePath: string, targetRoot = stageDirectory): void {
  const source = join(repositoryRoot, relativePath);
  assert(existsSync(source), `Missing required file ${relativePath}`);
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyRuntimeTree(source: string, target: string, options: CopyOptions = {}): void {
  assert(existsSync(source), `Missing source directory ${source}`);
  const sourceRoot = resolve(source);

  const visit = (currentSource: string, currentTarget: string): void => {
    if (
      currentSource !== sourceRoot &&
      options.stopAtPackageBoundaries &&
      packageDirectories.has(resolve(currentSource))
    )
      return;
    mkdirSync(currentTarget, { recursive: true });

    for (const entry of readdirSync(currentSource, { withFileTypes: true })) {
      const sourcePath = join(currentSource, entry.name);
      const targetPath = join(currentTarget, entry.name);
      const relativePath = toPosix(relative(sourceRoot, sourcePath));

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name, relativePath, options)) continue;
        visit(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile() || shouldSkipFile(entry.name, relativePath, options)) continue;
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
    }
  };

  visit(sourceRoot, target);
}

function shouldSkipDirectory(name: string, _relativePath: string, options: CopyOptions): boolean {
  if (name === "docs") return options.includeDocumentation !== true;
  if (forbiddenDirectoryNames.has(name)) return true;
  return name.startsWith(".");
}

function shouldSkipFile(name: string, _relativePath: string, options: CopyOptions): boolean {
  if (name.endsWith(".md") && options.includeDocumentation !== true) return true;
  return (
    name === "lefthook.yml" ||
    name === "pnpm-lock.yaml" ||
    name === "pnpm-workspace.yaml" ||
    /^tsconfig(?:\..+)?\.json$/.test(name) ||
    /\.config\.[cm]?[jt]s$/.test(name) ||
    /\.(?:integration\.)?test\.[cm]?[jt]sx?$/.test(name) ||
    /\.spec\.[cm]?[jt]sx?$/.test(name) ||
    name === "north-star.md"
  );
}

function validatePackage(
  packageRoot: string,
  packResult: PackResult,
  tarballPath: string,
): PackageReport {
  const paths: string[] = [];
  walk(packageRoot, (path) => paths.push(toPosix(relative(packageRoot, path))));
  const topLevel = [...new Set(paths.map((path) => path.split("/", 1)[0] ?? path))].sort();
  const unexpectedRoots = topLevel.filter((entry) => !allowedTarballRoots.has(entry));
  assert(unexpectedRoots.length === 0, `Unexpected tarball roots: ${unexpectedRoots.join(", ")}`);

  const forbidden = paths.filter(
    (path) =>
      isDevelopmentPath(path) ||
      path === "lefthook.yml" ||
      /\.(?:integration\.)?test\.[cm]?[jt]sx?$/.test(path) ||
      /\.spec\.[cm]?[jt]sx?$/.test(path),
  );
  assert(
    forbidden.length === 0,
    `Development files entered the tarball:\n${forbidden.slice(0, 30).join("\n")}`,
  );

  const packagedManifest = readJson(join(packageRoot, "package.json"));
  assert(packagedManifest.private === undefined, "Release manifest is private");
  assert(
    packagedManifest.devDependencies === undefined,
    "Release manifest contains devDependencies",
  );
  assert(
    packagedManifest.pi?.extensions?.length === 1,
    "Release manifest must expose one Pi extension",
  );
  assert(
    packagedManifest.pi.extensions[0] === "./dist/pi-agent-ide.js",
    "Unexpected Pi extension entrypoint",
  );

  for (const markdownPath of paths.filter((path) => path.endsWith(".md"))) {
    const markdown = readFileSync(join(packageRoot, markdownPath), "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (link === undefined) continue;
      const target = link.split("#", 1)[0] ?? "";
      if (target.length === 0 || /^[a-z]+:/i.test(target)) continue;
      const resolvedTarget = resolve(
        dirname(join(packageRoot, markdownPath)),
        decodeURIComponent(target),
      );
      assert(
        resolvedTarget.startsWith(`${packageRoot}${sep}`) && existsSync(resolvedTarget),
        `${markdownPath} links to missing ${target}`,
      );
    }
  }

  for (const [name, target] of Object.entries(packagedManifest.exports ?? {})) {
    for (const value of isRecord(target) ? Object.values(target) : [target]) {
      const expected = join(packageRoot, String(value).replace(/^\.\//, ""));
      assert(existsSync(expected), `Export ${name} misses ${value}`);
    }
  }

  for (const name of internalNames) {
    assert(
      packagedManifest.dependencies?.[name] === releaseVersion,
      `Missing bundled dependency ${name}`,
    );
    assert(
      packagedManifest.bundledDependencies?.includes(name),
      `Missing bundle declaration for ${name}`,
    );
    assert(
      existsSync(join(packageRoot, "node_modules", name, "package.json")),
      `Missing bundled package ${name}`,
    );
  }

  const manifestPaths = paths.filter((path) => path.endsWith("package.json"));
  for (const manifestPath of manifestPaths) {
    const manifestText = readFileSync(join(packageRoot, manifestPath), "utf8");
    const manifest = readJson(join(packageRoot, manifestPath));
    assert(manifest.private !== true, `${manifestPath} is private`);
    assert(manifest.devDependencies === undefined, `${manifestPath} contains devDependencies`);
    assert(
      !/(?:workspace:|file:|\/root\/)/.test(manifestText),
      `${manifestPath} contains a development path or range`,
    );
    for (const name of piPeerNames) {
      if (manifest.peerDependencies?.[name] !== undefined) {
        assert(
          manifest.peerDependencies[name] === "*",
          `${manifestPath} must use a star Pi peer for ${name}`,
        );
      }
    }
  }

  assert(
    packResult.unpackedSize < 25_000_000,
    `Tarball is unexpectedly large: ${packResult.unpackedSize} bytes`,
  );
  return {
    package: packagedManifest.name,
    version: packagedManifest.version,
    tarball: relative(repositoryRoot, tarballPath),
    size: packResult.size,
    unpackedSize: packResult.unpackedSize,
    files: paths.length,
    bundledPackages: internalNames.size,
    peerDependencies: packagedManifest.peerDependencies,
    topLevel,
  };
}

function walk(directory: string, callback: (path: string) => void): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, callback);
    else if (entry.isFile()) callback(path);
  }
}

function isDevelopmentPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment !== "node_modules" && forbiddenDirectoryNames.has(segment));
}

function readJson(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(isRecord(value), `${path} must contain a JSON object`);

  return {
    ...value,
    name: requiredString(value.name, `${path} name`),
    version: requiredString(value.version, `${path} version`),
    dependencies: optionalStringRecord(value.dependencies, `${path} dependencies`),
    peerDependencies: optionalStringRecord(value.peerDependencies, `${path} peerDependencies`),
    devDependencies: optionalStringRecord(value.devDependencies, `${path} devDependencies`),
    scripts: optionalStringRecord(value.scripts, `${path} scripts`),
    files: optionalStringArray(value.files, `${path} files`),
    bundledDependencies: optionalStringArray(
      value.bundledDependencies,
      `${path} bundledDependencies`,
    ),
    pi: parsePiManifest(value.pi, path),
  };
}

function parsePackResult(output: string): PackResult {
  const value: unknown = JSON.parse(output);
  assert(Array.isArray(value) && isRecord(value[0]), "npm pack did not return a result");
  const result = value[0];
  return {
    filename: requiredString(result.filename, "npm pack filename"),
    size: requiredNumber(result.size, "npm pack size"),
    unpackedSize: requiredNumber(result.unpackedSize, "npm pack unpacked size"),
  };
}

function requiredString(value: unknown, label: string): string {
  assert(typeof value === "string", `${label} must be a string`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a number`);
  return value;
}

function optionalStringRecord(value: unknown, label: string): StringRecord | undefined {
  if (value === undefined) return undefined;
  assert(isRecord(value), `${label} must be an object`);
  const entries = Object.entries(value);
  assert(
    entries.every((entry) => typeof entry[1] === "string"),
    `${label} values must be strings`,
  );
  return Object.fromEntries(entries.map(([key, entry]) => [key, requiredString(entry, label)]));
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  assert(
    Array.isArray(value) && value.every((entry) => typeof entry === "string"),
    `${label} must be a string array`,
  );
  return value;
}

function parsePiManifest(value: unknown, path: string): { extensions?: string[] } | undefined {
  if (value === undefined) return undefined;
  assert(isRecord(value), `${path} pi must be an object`);
  return { extensions: optionalStringArray(value.extensions, `${path} pi.extensions`) };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sortRecord(value: StringRecord): StringRecord {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
