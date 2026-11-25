#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPackage,
  hasErrorCode,
  isRecord,
  readJsonObject,
  singleExtension,
  verifyInstalledPi,
  writeJson,
} from "./public-package-smoke.mjs";

const backendName = "@nikolauska/linear-axi";
const runtimeRoots = ["src", "docs"];
const excludedDirectories = new Set([
  "node_modules",
  "dev",
  "test",
  "tests",
  "__tests__",
  "coverage",
  "benchmarks",
  "research",
]);
const rootFiles = ["README.md", "LICENSE"];
/** @param {string} file */
async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** @param {string} relativePath */
function excluded(relativePath) {
  const parts = relativePath.split("/");
  return (
    parts.some((part) => part.startsWith(".") || excludedDirectories.has(part)) ||
    /(?:^|\/)(?:lefthook\.yml|(?:package|npm)-lock\.json|tsconfig(?:\.[^/]*)?\.json)$/u.test(
      relativePath,
    ) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/u.test(relativePath) ||
    /\.(?:pem|key|pfx|p12)$/iu.test(relativePath)
  );
}

/** @param {string} source @param {string} destination @returns {Promise<void>} */
async function copyTree(source, destination, prefix = "") {
  const stat = await lstat(source);
  assertPackage(!stat.isSymbolicLink(), "RUNTIME_SYMLINK", `Refusing runtime symlink: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (!excluded(relative))
        await copyTree(path.join(source, entry), path.join(destination, entry), relative);
    }
  } else {
    assert(stat.isFile(), `Refusing non-regular runtime content: ${source}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

/** @param {string} directory @returns {Promise<string[]>} */
async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Refusing staged symlink: ${name}`);
    if (entry.isDirectory())
      files.push(...(await filesBelow(path.join(directory, entry.name), name)));
    else {
      assert(entry.isFile(), `Refusing staged special file: ${name}`);
      files.push(name);
    }
  }
  return files.sort();
}

/**
 * @param {unknown} dependencies
 * @param {string} [internalVersion]
 * @returns {Record<string, string>}
 */
function safeDependencies(dependencies, internalVersion) {
  if (dependencies === undefined) return {};
  assert(isRecord(dependencies), "Dependencies must be a JSON object");
  const entries = Object.entries(dependencies).map(
    /** @returns {[string, string]} */ ([name, version]) => {
      if (name === backendName && version === "workspace:*" && internalVersion !== undefined) {
        return [name, internalVersion];
      }
      if (
        name === "pi-agent-ide" &&
        typeof version === "string" &&
        /^workspace:\^\d+\.\d+\.\d+$/u.test(version)
      ) {
        return [name, version.slice("workspace:".length)];
      }
      assertPackage(
        typeof version === "string" && !/^(?:file:|workspace:|link:|\.\.?\/|\/)/u.test(version),
        "UNRESOLVED_RUNTIME_DEPENDENCY",
        `Unresolved local dependency: ${name}`,
      );
      return [name, version];
    },
  );
  return Object.fromEntries(entries);
}

/** @typedef {{ root: string; output?: string }} StageOptions */

/** @param {unknown} version @returns {string} */
function packageVersion(version) {
  assert(typeof version === "string", "Missing package version");
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Invalid package version");
  return version;
}

/**
 * Stage only product files. The private source manifests stay untouched.
 * @param {StageOptions} options
 */
export async function createPublicPackage({
  root,
  output = path.join(root, ".tmp/public-package"),
}) {
  root = path.resolve(root);
  output = path.resolve(output);
  assert(
    root !== output && !root.startsWith(`${output}${path.sep}`),
    "Output must not contain the source repository",
  );
  const source = await readJsonObject(path.join(root, "package.json"));
  const backendRoot = path.join(root, "packages/linear-axi");
  const backend = await readJsonObject(path.join(backendRoot, "package.json"));
  assert.equal(source.name, "pi-agent-linear", "Unexpected source package");
  assert.equal(backend.name, backendName, "Unexpected internal backend");
  const version = packageVersion(source.version);
  const backendVersion = packageVersion(backend.version);
  assertPackage(
    await exists(path.join(backendRoot, "dist/bin.js")),
    "AXI_NOT_BUILT",
    "Build the internal backend before packaging",
  );
  const dependencies = safeDependencies(source.dependencies, backendVersion);
  for (const [name, backendDependency] of Object.entries(safeDependencies(backend.dependencies))) {
    assertPackage(
      !Object.hasOwn(dependencies, name) || dependencies[name] === backendDependency,
      "RUNTIME_DEPENDENCY_CONFLICT",
      `Conflicting runtime dependency: ${name}`,
    );
    dependencies[name] = backendDependency;
  }
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, "run-"));
  const stage = path.join(directory, "stage");
  await mkdir(stage);
  for (const name of rootFiles) await copyTree(path.join(root, name), path.join(stage, name));
  for (const name of runtimeRoots) {
    await copyTree(path.join(root, name), path.join(stage, name));
  }
  if (await exists(path.join(root, "CHANGELOG.md")))
    await copyTree(path.join(root, "CHANGELOG.md"), path.join(stage, "CHANGELOG.md"));
  const internal = path.join(stage, "node_modules", backendName);
  for (const entry of ["bin.js", "worker.js"]) {
    const source = path.join(backendRoot, "dist", entry);
    assertPackage(
      await exists(source),
      "AXI_NOT_BUILT",
      `Build the internal backend before packaging (${entry})`,
    );
    await copyTree(source, path.join(internal, "dist", entry));
  }
  await copyTree(path.join(backendRoot, "LICENSE"), path.join(internal, "LICENSE"));
  await copyTree(path.join(backendRoot, "README.md"), path.join(internal, "README.md"));
  const internalManifest = structuredClone(backend);
  for (const field of [
    "private",
    "scripts",
    "devDependencies",
    "workspaces",
    "pi",
    "publishConfig",
    "files",
  ])
    delete internalManifest[field];
  if (isRecord(internalManifest.imports)) {
    delete internalManifest.imports["#axi/*"];
    delete internalManifest.imports["#axi-test/*"];
  }
  internalManifest.dependencies = safeDependencies(backend.dependencies);
  internalManifest.peerDependencies = safeDependencies(backend.peerDependencies);
  await writeJson(path.join(internal, "package.json"), internalManifest);
  const manifest = structuredClone(source);
  for (const field of ["private", "scripts", "devDependencies", "workspaces"])
    delete manifest[field];
  if (isRecord(manifest.imports)) {
    for (const alias of ["#linear-tests/*", "#linear-scripts/*", "#linear-axi/*"]) {
      delete manifest.imports[alias];
    }
  }
  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  manifest.peerDependencies = safeDependencies(source.peerDependencies);
  manifest.bundledDependencies = [backendName];
  manifest.files = [
    ...runtimeRoots,
    ...rootFiles,
    ...((await exists(path.join(stage, "CHANGELOG.md"))) ? ["CHANGELOG.md"] : []),
  ];
  manifest.publishConfig = { access: "public" };
  await writeJson(path.join(stage, "package.json"), manifest);

  const files = await filesBelow(stage);
  return { directory, stage, files, name: source.name, version };
}

/**
 * Pack the exact staged runtime and verify the archive's complete file list. Never publish.
 * @param {StageOptions} options
 */
export async function packPublicPackage(options) {
  const result = await createPublicPackage(options);
  const receipt = parsePackReceipt(
    execFileSync("npm", ["pack", "--json", "--pack-destination", result.directory], {
      cwd: result.stage,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const tarball = path.join(result.directory, receipt.filename);
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((name) => !name.endsWith("/"))
    .map((name) => {
      assert(name.startsWith("package/"), "Unexpected tarball root");
      return name.slice(8);
    })
    .sort();
  for (const file of files) {
    const relative = file.startsWith(`node_modules/${backendName}/`)
      ? file.slice(`node_modules/${backendName}/`.length)
      : file;
    // The exclusion check rejects every dot-prefixed path segment, including parent traversal.
    assert(!excluded(relative), `Forbidden tarball entry: ${file}`);
  }
  assert.deepEqual(files, result.files, "Archive files differ from the staged runtime");
  const sha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  const report = {
    ...result,
    files,
    tarball,
    sha256,
    size: receipt.size,
    unpackedSize: receipt.unpackedSize,
    installVerified: false,
  };
  await writeJson(path.join(result.directory, "report.json"), report);
  return report;
}

/** @param {string} output */
function parsePackReceipt(output) {
  /** @type {unknown} */
  const value = JSON.parse(output);
  assert(Array.isArray(value) && value.length === 1, "Invalid npm pack receipt");
  /** @type {unknown} */
  const receipt = value[0];
  assert(isRecord(receipt), "Invalid npm pack receipt");
  const { filename, size, unpackedSize } = receipt;
  assert(
    typeof filename === "string" &&
      filename.endsWith(".tgz") &&
      path.basename(filename) === filename &&
      typeof size === "number" &&
      Number.isFinite(size) &&
      typeof unpackedSize === "number" &&
      Number.isFinite(unpackedSize),
    "Invalid npm pack receipt",
  );
  return { filename, size, unpackedSize };
}

/**
 * Install the actual archive, keeping normal lifecycle behavior and no source-tree links.
 * @param {Awaited<ReturnType<typeof packPublicPackage>>} report
 */
export async function verifyInstalledPackage(report) {
  const consumer = await mkdtemp(path.join(os.tmpdir(), "linear-package-consumer-"));
  await writeJson(path.join(consumer, "package.json"), {
    name: "linear-package-consumer",
    version: "1.0.0",
    private: true,
  });
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", report.tarball],
    {
      cwd: consumer,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const installed = path.join(consumer, "node_modules", report.name);
  const require = createRequire(path.join(installed, "package.json"));
  const cli = require.resolve(`${backendName}/dist/bin.js`);
  assert(cli.startsWith(`${consumer}${path.sep}`), "Backend resolved outside clean consumer");
  const help = execFileSync(process.execPath, [cli, "--help"], { cwd: consumer, encoding: "utf8" });
  assert.match(help, /usage: linear-axi/u, "Installed backend did not run");
  const installedManifest = await readJsonObject(path.join(installed, "package.json"));
  assert.equal(
    installedManifest.scripts,
    undefined,
    "Installed package retained development lifecycle scripts",
  );
  const extension = singleExtension(installedManifest, "Linear");
  assert(
    await exists(path.join(installed, extension)),
    `Missing installed extension: ${extension}`,
  );
  const installedReport = {
    ...report,
    installVerified: true,
    piLoadVerified: false,
    consumer,
    backend: cli,
  };
  // Keep this checkpoint if a later Pi smoke fails; never lose the known installation outcome.
  await writeJson(path.join(report.directory, "report.json"), installedReport);
  const verified = await verifyInstalledPi(installedReport);
  await writeJson(path.join(report.directory, "report.json"), verified);
  return verified;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(
      args.every((arg) => arg === "--verify-install") && args.length <= 1,
      "Usage: node scripts/build-public-package.mjs [--verify-install]",
    );
    const root = path.dirname(fileURLToPath(import.meta.resolve("#linear-package")));
    let report = await packPublicPackage({ root });
    if (args.includes("--verify-install")) report = await verifyInstalledPackage(report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("public-package:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
