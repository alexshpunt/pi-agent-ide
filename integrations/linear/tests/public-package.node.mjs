import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createPublicPackage, packPublicPackage } from "#linear-scripts/build-public-package.mjs";
import { installedPackageEntries } from "#linear-scripts/public-package-smoke.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "linear-public-package-"));
  const source = path.join(directory, "source");
  const output = path.join(directory, "output");
  /** @param {string} name @param {string | object} content */
  async function file(name, content) {
    const target = path.join(source, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  const id = "71000000-0000-4000-8000-000000000001";
  const manifest = {
    name: "pi-agent-linear",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { prepare: "node missing-development-build.js" },
    dependencies: { "@nikolauska/linear-axi": "workspace:*" },
    devDependencies: { typescript: "^6.0.0" },
    workspaces: ["packages/*"],
    pi: { extensions: ["./src/index.ts"] },
  };
  await file("package.json", manifest);
  await file("README.md", "# Linear\n");
  await file("LICENSE", "MIT License\n");
  await file("src/index.ts", "export default function linear() {}\n");
  await file("src/dev/private.txt", "must not ship\n");
  await file("src/.tmp/private.txt", "must not ship\n");
  await file("docs/usage.md", "Read linear://your-workspace/issue/ENG-12\n");
  await file(".pi/linear.json", { axiPath: "private-backend" });
  await file(".linear-project", { workspace: "example-fixture", project: id });
  await file("packages/linear-axi/package.json", {
    name: "@nikolauska/linear-axi",
    version: "0.3.1",
    private: true,
    type: "module",
    scripts: { prepack: "node missing-development-build.js" },
    bin: { "linear-axi": "dist/bin.js" },
    dependencies: {},
    devDependencies: { typescript: "^7.0.0" },
    pi: { extensions: ["dist/extension.js"] },
  });
  await file("packages/linear-axi/dist/bin.js", "console.log('usage: linear-axi');\n");
  await file("packages/linear-axi/dist/worker.js", "export {};\n");
  await file("packages/linear-axi/dist/old-build.js", "export {};\n");
  await file("packages/linear-axi/LICENSE", "MIT License\nOriginal backend notice\n");
  await file("packages/linear-axi/README.md", "# Bundled AXI backend\n");
  return { directory, source, output, file, manifest };
}

/** @param {(state: Awaited<ReturnType<typeof fixture>>) => Promise<void>} body */
async function withFixture(body) {
  const state = await fixture();
  try {
    await body(state);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function jsonObject(value) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} file */
async function json(file) {
  return jsonObject(JSON.parse(await readFile(file, "utf8")));
}

void test("stages a public runtime without changing private source", () =>
  withFixture(async (f) => {
    const result = await createPublicPackage({ root: f.source, output: f.output });
    const manifest = await json(path.join(result.stage, "package.json"));
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.workspaces, undefined);
    assert.equal(jsonObject(manifest.dependencies)["@nikolauska/linear-axi"], "0.3.1");
    assert.deepEqual(manifest.bundledDependencies, ["@nikolauska/linear-axi"]);
    const backend = await json(
      path.join(result.stage, "node_modules/@nikolauska/linear-axi/package.json"),
    );
    assert.equal(backend.private, undefined);
    assert.equal(backend.scripts, undefined);
    assert.equal(backend.pi, undefined);
    assert.equal(
      await readFile(
        path.join(result.stage, "node_modules/@nikolauska/linear-axi/README.md"),
        "utf8",
      ),
      "# Bundled AXI backend\n",
    );
    assert.match(
      await readFile(
        path.join(result.stage, "node_modules/@nikolauska/linear-axi/LICENSE"),
        "utf8",
      ),
      /Original backend notice/,
    );
    assert.equal(
      await readFile(path.join(result.stage, "docs/usage.md"), "utf8"),
      "Read linear://your-workspace/issue/ENG-12\n",
    );
    assert.equal(
      result.files.some((name) => name === ".linear-project" || name.startsWith(".pi/")),
      false,
    );
    assert.equal(
      result.files.some((name) => name.includes("/dev/") || name.includes("/.tmp/")),
      false,
    );
    assert.deepEqual(await json(path.join(f.source, "package.json")), f.manifest);
  }));

void test("publishes the SDK range independently from the Linear version", () =>
  withFixture(async (f) => {
    await f.file("package.json", {
      ...f.manifest,
      dependencies: { ...f.manifest.dependencies, "pi-agent-ide": "workspace:^1.1.0" },
    });
    const result = await createPublicPackage({ root: f.source, output: f.output });
    const manifest = await json(path.join(result.stage, "package.json"));
    assert.equal(manifest.version, f.manifest.version);
    assert.equal(jsonObject(manifest.dependencies)["pi-agent-ide"], "^1.1.0");
  }));

void test("hoists declared backend runtime dependencies and rejects incompatible ranges", () =>
  withFixture(async (f) => {
    const backendFile = path.join(f.source, "packages/linear-axi/package.json");
    const backend = await json(backendFile);
    await f.file("packages/linear-axi/package.json", {
      ...backend,
      dependencies: { "runtime-example": "^1.2.0" },
    });
    const result = await createPublicPackage({ root: f.source, output: f.output });
    assert.equal(
      jsonObject((await json(path.join(result.stage, "package.json"))).dependencies)[
        "runtime-example"
      ],
      "^1.2.0",
    );
    assert.equal(
      jsonObject(
        (await json(path.join(result.stage, "node_modules/@nikolauska/linear-axi/package.json")))
          .dependencies,
      )["runtime-example"],
      "^1.2.0",
    );
    await f.file("package.json", {
      ...f.manifest,
      dependencies: { ...f.manifest.dependencies, "runtime-example": "^2.0.0" },
    });
    await assert.rejects(createPublicPackage({ root: f.source, output: f.output }), {
      code: "RUNTIME_DEPENDENCY_CONFLICT",
    });
  }));
void test("rejects an unbuilt backend and unexpected local runtime dependencies", () =>
  withFixture(async (f) => {
    await rm(path.join(f.source, "packages/linear-axi/dist"), { recursive: true });
    await assert.rejects(createPublicPackage({ root: f.source, output: f.output }), {
      code: "AXI_NOT_BUILT",
    });
    await f.file("packages/linear-axi/dist/bin.js", "console.log('usage: linear-axi');\n");
    await f.file("package.json", {
      ...f.manifest,
      dependencies: {
        ...f.manifest.dependencies,
        hidden: pathToFileURL(path.join(f.directory, "secret")).href,
      },
    });
    await assert.rejects(createPublicPackage({ root: f.source, output: f.output }), {
      code: "UNRESOLVED_RUNTIME_DEPENDENCY",
    });
  }));

void test("rejects symlinked runtime content", () =>
  withFixture(async (f) => {
    await symlink(path.join(f.source, "README.md"), path.join(f.source, "src/secret.ts"));
    await assert.rejects(createPublicPackage({ root: f.source, output: f.output }), {
      code: "RUNTIME_SYMLINK",
    });
  }));

void test("installed smoke refuses a source-linked product before loading Pi", () =>
  withFixture(async (f) => {
    const consumer = path.join(f.directory, "consumer");
    const installed = path.join(consumer, "node_modules/pi-agent-linear");
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, "package.json"), JSON.stringify(f.manifest));
    await symlink(path.join(f.source, "src"), path.join(installed, "src"));
    await assert.rejects(installedPackageEntries({ name: "pi-agent-linear", consumer }), {
      code: "PACKAGE_ENTRY_OUTSIDE_CONSUMER",
    });
  }));
void test("installs the actual tarball with normal lifecycle behavior and runs its bundled backend", () =>
  withFixture(async (f) => {
    const result = await packPublicPackage({ root: f.source, output: f.output });
    const consumer = path.join(f.directory, "consumer");
    await mkdir(consumer);
    await writeFile(
      path.join(consumer, "package.json"),
      '{"name":"linear-consumer","version":"1.0.0","private":true}',
    );
    execFileSync(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", result.tarball],
      {
        cwd: consumer,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: path.join(f.directory, "cache") },
      },
    );
    const installed = path.join(consumer, "node_modules/pi-agent-linear");
    assert.equal((await json(path.join(installed, "package.json"))).scripts, undefined);
    const cli = path.join(installed, "node_modules/@nikolauska/linear-axi/dist/bin.js");
    assert.match(
      execFileSync(process.execPath, [cli, "--help"], { cwd: consumer, encoding: "utf8" }),
      /usage: linear-axi/,
    );
    assert.equal(result.files.includes("node_modules/@nikolauska/linear-axi/LICENSE"), true);
    assert.equal(result.files.includes("node_modules/@nikolauska/linear-axi/dist/worker.js"), true);
    assert.equal(
      result.files.includes("node_modules/@nikolauska/linear-axi/dist/old-build.js"),
      false,
    );
    assert.equal(result.files.includes(".linear-project"), false);
    assert.equal(result.files.includes("package-lock.json"), false);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  }));
