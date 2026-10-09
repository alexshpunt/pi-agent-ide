import assert from "node:assert/strict";
import { captureIdeSource } from "./ide-source.mjs";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ideRoot = "/root/dev/pi/pi-agent-ide";
const worktree = findRepositoryRoot(import.meta.url);
const cliRun = path.resolve(process.argv[2] ?? path.join(worktree, ".tmp/rea-baseline/run-QhoZGN"));
const report = JSON.parse(await readFile(path.join(cliRun, "result.json"), "utf8"));
await execute("git", ["-C", ideRoot, "fetch", "origin", "develop"]);
const revision = async (ref) =>
  (await execute("git", ["-C", ideRoot, "rev-parse", ref])).stdout.trim();
const commit = await revision("HEAD");
assert.equal(commit, await revision("origin/develop"));
const version = JSON.parse(await readFile(path.join(ideRoot, "package.json"), "utf8")).version;
const beforeSource = await captureIdeSource(ideRoot);
const require = createRequire(path.join(ideRoot, "package.json"));
const { PiIntegrationTest, assistantMessage, toolCall, text, getToolExecution } = await import(
  pathToFileURL(
    path.join(path.dirname(require.resolve("pi-coding-agent-test/package.json")), "dist/base.js"),
  ).href
);
const root = await mkdtemp(path.join(worktree, ".tmp/rea-baseline/proto-"));
const binary = path.join(root, "catalog");
const application = path.join(root, "electron");
await Promise.all([
  cp(path.join(cliRun, "catalog"), binary),
  cp(path.join(cliRun, "electron"), application, { recursive: true }),
]);
const config = {
  binary,
  application,
  reaRoot: path.join(worktree, ".tmp/lpt-709/published/package"),
  packageVersion: report.rea.version,
  entrySha256: report.rea.entrySha256,
  javaHome: report.nativeTools.javaHome,
  ghidraRoot: report.nativeTools.ghidraRoot,
  resultsRoot: path.join(root, "mcp"),
};
await mkdir(path.join(root, ".pi/pi-agent-ide"), { recursive: true });
await writeFile(path.join(root, ".pi/settings.json"), JSON.stringify({ codemode: { mode: "on" } }));
await writeFile(
  path.join(root, ".pi/pi-agent-ide/extensions.json"),
  JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
);
const bootstrap = path.join(root, "bootstrap.ts");
await writeFile(
  bootstrap,
  `import { installRea } from ${JSON.stringify(path.join(import.meta.dirname, "extension.ts"))};
import { captureIdeSource } from ${JSON.stringify(path.join(import.meta.dirname, "ide-source.mjs"))};
import { writeFile } from "node:fs/promises";
export default async function(pi) {
  await installRea(pi, ${JSON.stringify(config)});
  pi.on("session_start", async () => {
    const loaded = await captureIdeSource();
    await writeFile(${JSON.stringify(path.join(root, "loaded-ide.json"))}, JSON.stringify({...loaded, extension:${JSON.stringify(path.join(ideRoot, "src/pi-agent-ide.ts"))}, tools:pi.getAllTools().map(tool=>tool.name)}, null, 2));
  });
}
`,
);
await writeFile(
  path.join(root, "run.json"),
  JSON.stringify(
    {
      kind: "real-pi-scripted-smoke",
      modelCalls: 0,
      ide: {
        source: ideRoot,
        version,
        commit,
        extension: path.join(ideRoot, "src/pi-agent-ide.ts"),
      },
      config,
    },
    null,
    2,
  ),
);

const harness = path.join(root, "harness");
await mkdir(harness);
for (const file of [
  "extension.ts",
  "connection.mjs",
  "owner.mjs",
  "smoke.mjs",
  "ide-source.mjs",
  "matches.mjs",
]) {
  await cp(path.join(import.meta.dirname, file), path.join(harness, file));
}
await writeFile(path.join(root, "ide-before.json"), JSON.stringify(beforeSource, null, 2));
await writeFile(
  path.join(root, "ide-source.patch"),
  (
    await execute(
      "git",
      [
        "-C",
        ideRoot,
        "diff",
        "--binary",
        "--",
        "src",
        "packages",
        "package.json",
        "pnpm-lock.yaml",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
  ).stdout,
);
const code = `
if (ALL_TOOLS.some(tool => ["analyze_function", "open_binary", "close_binary", "binary_session", "analyze_javascript_application"].includes(tool.name))) throw new Error("REA tools leaked into the agent catalog");
const native = await tools.read({path:"rea://native/catalog_rank"});
const body = await tools.select({path:native,operation:{kind:"between",start:"int catalog_rank(",end:"return iVar1;",extent:"inside"}});
const found = await tools.search({path:body,query:"strcmp",caseSensitive:true});
const line = await tools.read({path:found});
if (!line.includes('iVar1 = strcmp(query,"native");')) throw new Error("Missing native code selection");
const narrow = await tools.select({path:found,operation:{kind:"linesOf"}});
const narrowedRead = await tools.read({path:narrow});
if (narrowedRead.includes("Callers:")) throw new Error("Selection widened into provenance");
const absent = await tools.search({path:body,query:"Ghidra"});
if (!absent.includes("0 REA static text matches")) throw new Error("Search widened its source scope");
const app = await tools.read({path:"rea://application/summary"});
if (!app.includes('"context_bridge_apis": 1')) throw new Error("Missing JS summary");
let unsupported = false;
try { await tools.search({path:body,query:"symbols:catalog_rank"}); } catch { unsupported = true; }
if (!unsupported) throw new Error("Unsupported native symbol semantics accepted");
let readOnly = false;
try { await tools.replace({path:found,text:"should not write"}); } catch { readOnly = true; }
if (!readOnly) throw new Error("REA Resource allowed replacing");
let writeRefused = false;
try { await tools.write({path:native,content:"should not overwrite a REA snapshot"}); } catch { writeRefused = true; }
if (!writeRefused) throw new Error("REA Resource allowed Write");
await tools.read({path:native});
store("rea_native",native);
text({nativeSelection:true,scopePreserved:true,staticJsSummary:true,unsupportedQueryRejected:unsupported,readOnly});
`;
const staleCode = `
const old = load("rea_native");
if (typeof old !== "string") throw new Error("Missing successful snapshot from the composition step");
await tools.write({path:${JSON.stringify(binary)},content:"changed owned artifact"});
let rejected = false;
try { await tools.select({path:old,operation:{kind:"position",edge:"before"}}); } catch { rejected = true; }
if (!rejected) throw new Error("Changed artifact retained authority");
text({changedInputRejected:rejected});
`;
const result = await new PiIntegrationTest({
  testName: "rea-resource-private-mcp",
  artifactsDir: path.join(root, "pi"),
  rawMode: false,
  cwd: root,
  timeoutMs: 120000,
  isolateUserResources: true,
  environment: { PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1" },
  extensions: [path.join(ideRoot, "src/pi-agent-ide.ts"), "builtin:codemode", bootstrap],
  tools: ["codemode", "read", "search", "select", "replace", "write"],
  conversation: [
    assistantMessage([toolCall({ id: "rea-compose", name: "codemode", arguments: { code } })], {
      stopReason: "toolUse",
    }),
    assistantMessage(
      [toolCall({ id: "rea-stale", name: "codemode", arguments: { code: staleCode } })],
      { stopReason: "toolUse" },
    ),
    assistantMessage([text("Research smoke complete")]),
  ],
}).run("Run the scripted REA resource smoke without inference");
const afterSource = await captureIdeSource(ideRoot);
await writeFile(path.join(root, "ide-after.json"), JSON.stringify(afterSource, null, 2));
const loaded = JSON.parse(await readFile(path.join(root, "loaded-ide.json"), "utf8"));
assert.equal(loaded.sourceDigest, beforeSource.sourceDigest, "IDE changed before startup");
assert.equal(afterSource.sourceDigest, loaded.sourceDigest, "IDE source changed during the run");
assert.ok(["read", "search", "select"].every((tool) => loaded.tools.includes(tool)));
assert.ok(
  !loaded.tools.some((tool) =>
    ["analyze_function", "open_binary", "close_binary", "binary_session"].includes(tool),
  ),
);
await writeFile(
  path.join(root, "inspection.json"),
  JSON.stringify(
    {
      providerRequests: result.providerRequests,
      compose: getToolExecution(result, "rea-compose"),
      stale: getToolExecution(result, "rea-stale"),
    },
    null,
    2,
  ),
);
assert.equal(getToolExecution(result, "rea-compose").isError, false, "REA tool composition failed");
assert.equal(getToolExecution(result, "rea-stale").isError, false, "REA freshness failed");
console.log(
  JSON.stringify(
    { root, ide: { source: ideRoot, version, commit }, passed: true, modelCalls: 0 },
    null,
    2,
  ),
);
