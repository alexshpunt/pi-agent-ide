import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** @param {unknown} error @param {string} code */
export function hasErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** @param {string} file @returns {Promise<Record<string, unknown>>} */
export async function readJsonObject(file) {
  /** @type {unknown} */
  const value = JSON.parse(await readFile(file, "utf8"));
  assert(isRecord(value), `Expected JSON object: ${file}`);
  return value;
}

/** @param {string} file @param {unknown} value */
export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Keep failure classification independent of diagnostic text.
 * @param {unknown} condition
 * @param {string} code
 * @param {string} message
 * @returns {asserts condition}
 */
export function assertPackage(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

/** @param {Record<string, unknown>} manifest @param {string} label */
export function singleExtension(manifest, label) {
  const config = manifest.pi;
  assert(isRecord(config), `Expected ${label} Pi manifest`);
  const entries = config.extensions;
  assert(isStringArray(entries) && entries.length === 1, `Expected one ${label} extension entry`);
  const [entry] = entries;
  assert(entry, `Missing ${label} extension entry`);
  return entry;
}

/** @typedef {{ consumer: string; name: string }} InstalledPackage */

/**
 * Resolve only installed product/SDK entries; never substitute a source checkout or global Pi.
 * @param {InstalledPackage} report
 */
export async function installedPackageEntries(report) {
  const consumer = await realpath(report.consumer);
  /** @param {string} file @param {string} label */
  const inside = async (file, label) => {
    const resolved = await realpath(file);
    assertPackage(
      resolved.startsWith(`${consumer}${path.sep}`),
      "PACKAGE_ENTRY_OUTSIDE_CONSUMER",
      `${label} resolves outside the clean consumer`,
    );
    return resolved;
  };
  const installed = path.join(consumer, "node_modules", report.name);
  const manifest = await readJsonObject(path.join(installed, "package.json"));
  assert.equal(manifest.name, "pi-agent-linear", "Unexpected installed product");
  const linear = await inside(
    path.resolve(installed, singleExtension(manifest, "Linear")),
    "Linear extension",
  );
  const require = createRequire(path.join(installed, "package.json"));
  let sdk = path.dirname(await inside(require.resolve("pi-agent-ide/api/read"), "IDE SDK"));
  /** @type {string | undefined} */
  let ide;
  for (let depth = 0; depth < 8; depth++, sdk = path.dirname(sdk)) {
    let candidate;
    try {
      candidate = await readJsonObject(path.join(sdk, "package.json"));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      continue;
    }
    if (candidate.name !== "pi-agent-ide") continue;
    ide = await inside(path.resolve(sdk, singleExtension(candidate, "IDE")), "IDE extension");
    break;
  }
  assert(ide, "Installed IDE extension not found");
  const piCommand = await inside(path.join(consumer, "node_modules/.bin/pi"), "Pi CLI");
  return { consumer, installed, linear, ide, ideRoot: sdk, piCommand };
}

/**
 * Add and remove the installed Linear package without changing the IDE registration.
 * @param {Awaited<ReturnType<typeof installedPackageEntries>>} entries
 * @param {string} directory
 */
async function verifyPackageRegistration(entries, directory) {
  const agentDir = await mkdtemp(path.join(directory, "agent-"));
  const settings = path.join(agentDir, "settings.json");
  const { ideRoot } = entries;
  /** @param {...string} args */
  const run = (...args) =>
    execFileSync(process.execPath, [entries.piCommand, ...args], {
      cwd: entries.consumer,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const packages = async () => {
    const saved = (await readJsonObject(settings)).packages;
    assert(isStringArray(saved), "Pi saved an invalid package list");
    return saved.map((entry) => path.resolve(agentDir, entry));
  };
  run("install", ideRoot);
  run("install", entries.installed);
  assert.deepEqual(await packages(), [ideRoot, entries.installed]);
  run("remove", entries.installed);
  assert.deepEqual(await packages(), [ideRoot]);
}

/**
 * Exercise the tarball's real extension loader and tools with a local scripted provider/backend.
 * @template {InstalledPackage & { directory: string }} Report
 * @param {Report} report
 */
export async function verifyInstalledPi(report) {
  const entries = await installedPackageEntries(report);
  const {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    text,
    toolCall,
  } = await import("pi-coding-agent-test");
  const directory = await mkdtemp(path.join(report.directory, "pi-smoke-"));
  await verifyPackageRegistration(entries, directory);
  const modes = [];
  for (const mode of ["standalone", "ide-first", "linear-first"]) {
    const cwd = await mkdtemp(path.join(directory, `${mode}-`));
    await mkdir(path.join(cwd, ".pi"));
    const backend = path.join(cwd, "fixture-backend.mjs");
    await writeFile(
      backend,
      'import { appendFileSync } from "node:fs";\nimport path from "node:path";\nconst args = process.argv.slice(2);\nappendFileSync(path.join(process.cwd(), "backend-calls.jsonl"), JSON.stringify(args) + "\\n");\nif (args.length === 3 && args[0] === "auth" && args[1] === "epoch" && args[2] === "--json") {\n  console.log(JSON.stringify({ state: "legacy", epoch: "installed-fixture" }));\n  process.exit(0);\n}\nif (args[0] !== "issues" || args[1] !== "view" || args[2] !== "ENG-12") process.exit(91);\nif (process.env.LINEAR_AXI_AUTH_EPOCH !== "installed-fixture") process.exit(92);\nconsole.log("issue:\\n  id: ENG-12\\n  title: Installed package fixture\\n  url: https://linear.app/example/issue/ENG-12/installed-package-fixture\\n  description: Read from the installed Linear extension.");\n',
    );
    await writeJson(path.join(cwd, ".pi/linear.json"), { axiPath: backend });
    const standalone = mode === "standalone";
    const read = standalone ? "linear_read" : "read";
    /** @type {[string, string, Record<string, unknown>][]} */
    const steps = [
      [
        "discover",
        "tool_search",
        { query: standalone ? "linear read" : "linear_read standalone", limit: 8 },
      ],
      ["guide", read, { path: "docs:linear" }],
      [
        "issue",
        read,
        { path: "https://linear.app/example/issue/ENG-12/installed-package-fixture" },
      ],
    ];
    const extensions = standalone
      ? [entries.linear]
      : mode === "ide-first"
        ? [entries.ide, entries.linear]
        : [entries.linear, entries.ide];
    const result = await new PiIntegrationTest({
      testName: `installed-linear-${mode}`,
      artifactsDir: directory,
      cwd,
      isolateUserResources: true,
      rawMode: false,
      piCommand: entries.piCommand,
      extensions: ["builtin:tool-search", ...extensions],
      tools: standalone ? ["tool_search"] : ["read", "tool_search"],
      timeoutMs: 60_000,
      conversation: [
        ...steps.map(([id, name, args]) =>
          assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Installed package smoke finished.")]),
      ],
    }).run(
      "Use only the installed Linear package and local fixture; do not access a real Linear workspace.",
    );
    for (const [id] of steps)
      assert.equal(
        Boolean(getToolExecution(result, id).isError),
        false,
        `${mode}/${id}: ${getToolResultText(result, id)}`,
      );
    assert.match(
      getToolResultText(result, "guide"),
      /Linear/u,
      `${mode}: packaged guide unavailable`,
    );
    assert.match(
      getToolResultText(result, "issue"),
      /Installed package fixture/u,
      `${mode}: installed resource read failed`,
    );
    if (standalone)
      assert.match(
        getToolResultText(result, "discover"),
        /linear_read/u,
        "Standalone tools were not discoverable",
      );
    else
      assert(
        !getToolResultText(result, "discover").includes("linear_read"),
        `${mode}: duplicate standalone tools`,
      );
    assert(
      !/Failed to load extension|already handles/u.test(result.tuiRenderedOutput),
      `${mode}: extension or duplicate registration error`,
    );
    const backendCalls = (await readFile(path.join(cwd, "backend-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        /** @type {unknown} */
        const args = JSON.parse(line);
        assert(isStringArray(args), "Invalid backend invocation receipt");
        return args;
      });
    /** @param {string[]} args */
    const business = (args) => args[0] === "issues" && args[1] === "view" && args[2] === "ENG-12";
    /** @param {string[]} args */
    const epoch = (args) =>
      args.length === 3 && args[0] === "auth" && args[1] === "epoch" && args[2] === "--json";
    assert(
      backendCalls.some(business) && backendCalls.every((args) => business(args) || epoch(args)),
      `${mode}: unexpected backend invocation`,
    );
    assert(backendCalls.some(epoch), `${mode}: installed auth epoch was not checked`);
    modes.push({ mode, passed: true, artifacts: result.artifacts.directory, backendCalls });
  }
  return {
    ...report,
    piLoadVerified: true,
    piRegistrationVerified: true,
    piSmoke: {
      entries,
      linearEntrySha256: createHash("sha256")
        .update(await readFile(entries.linear))
        .digest("hex"),
      modes,
    },
  };
}
