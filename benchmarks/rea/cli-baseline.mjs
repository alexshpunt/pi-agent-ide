import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { validateApplication } from "./validate-js.mjs";
import { validateNative } from "./validate-native.mjs";

const execute = promisify(execFile);
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const nativeCases = [
  ["", "-1\n"],
  ["a", "-1\n"],
  ["ab", "-1\n"],
  ["abc", "0\n"],
  ["native", "11\n"],
  ["NATIVE", "0\n"],
  ["ghidra", "7\n"],
  ["GHI", "7\n"],
  ["game", "7\n"],
  ["xxnative", "0\n"],
];

/** Run a no-model CLI baseline, keeping raw outputs and every failed attempt in a fresh directory. */
export async function runBaseline({ reaRoot, resultsRoot, ideRoot }) {
  reaRoot = path.resolve(reaRoot);
  ideRoot = path.resolve(ideRoot);
  await execute("git", ["-C", ideRoot, "fetch", "origin", "develop"]);
  const revision = async (ref) =>
    (await execute("git", ["-C", ideRoot, "rev-parse", ref])).stdout.trim();
  const commit = await revision("HEAD");
  assert.equal(
    commit,
    await revision("origin/develop"),
    "IDE checkout must match latest origin/develop",
  );
  const idePackage = JSON.parse(await readFile(path.join(ideRoot, "package.json"), "utf8"));
  const reaPackage = JSON.parse(await readFile(path.join(reaRoot, "package.json"), "utf8"));
  assert.equal(reaPackage.name, "rea-agents");
  const requireRea = createRequire(path.join(reaRoot, "package.json"));
  const asar = requireRea("@electron/asar");
  await mkdir(resultsRoot, { recursive: true });
  const root = await mkdtemp(path.join(path.resolve(resultsRoot), "run-"));
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(temporary)]);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    TMPDIR: temporary,
  };
  const records = [];
  const entry = path.join(reaRoot, "scripts", "rea.mjs");
  const report = {
    kind: "deterministic-cli-baseline",
    startedAt: new Date().toISOString(),
    ide: { source: ideRoot, version: idePackage.version, commit, piChildLaunched: false },
    rea: {
      source: reaRoot,
      version: reaPackage.version,
      entrySha256: digest(await readFile(entry)),
    },
    host: { platform: process.platform, architecture: process.arch, node: process.version },
    modelCalls: 0,
    runnerSha256: digest(await readFile(fileURLToPath(import.meta.url))),
    validatorSha256: digest(await readFile(new URL("./validate-js.mjs", import.meta.url))),
    nativeValidatorSha256: digest(
      await readFile(new URL("./validate-native.mjs", import.meta.url)),
    ),
    root,
    records,
  };
  if (env.GHIDRA_INSTALL_DIR && env.JAVA_HOME) {
    report.nativeTools = {
      ghidraRoot: env.GHIDRA_INSTALL_DIR,
      javaHome: env.JAVA_HOME,
      ghidraProperties: await readFile(
        path.join(env.GHIDRA_INSTALL_DIR, "Ghidra", "application.properties"),
        "utf8",
      ),
      javaRelease: await readFile(path.join(env.JAVA_HOME, "release"), "utf8"),
    };
  }
  const save = () =>
    writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2) + "\n");
  await save();

  async function command(id, executable, args, timeout = 120000) {
    const started = performance.now();
    let stdout;
    let stderr;
    let exitCode = 0;
    let error;
    try {
      ({ stdout, stderr } = await execute(executable, args, {
        cwd: root,
        env,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (failure) {
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? "";
      exitCode = typeof failure.code === "number" ? failure.code : null;
      error = {
        message: failure.message,
        code: failure.code,
        signal: failure.signal,
        killed: failure.killed,
      };
    }
    const output = path.join(root, `${id}.stdout`);
    const diagnostics = path.join(root, `${id}.stderr`);
    await Promise.all([writeFile(output, stdout), writeFile(diagnostics, stderr)]);
    const record = {
      id,
      executable,
      args,
      exitCode,
      elapsedMs: Math.round(performance.now() - started),
      output,
      diagnostics,
      stdoutBytes: Buffer.byteLength(stdout),
      stdoutLines: stdout.split("\n").length,
      ...(error ? { error } : {}),
    };
    records.push(record);
    await save();
    return { record, stdout };
  }

  try {
    const harness = path.join(root, "harness");
    await mkdir(harness);
    for (const file of ["cli-baseline.mjs", "validate-js.mjs", "validate-native.mjs"]) {
      await cp(fileURLToPath(new URL(file, import.meta.url)), path.join(harness, file));
    }
    await cp(fixtures, path.join(harness, "fixtures"), { recursive: true });
    const nativeSources = path.join(harness, "fixtures", "native");
    await command("compiler-version", "gcc", ["--version"]);
    const app = path.join(root, "electron");
    await cp(path.join(fixtures, "electron"), app, { recursive: true });
    const leaf = createRequire(path.join(app, "package.json"))("./search.cjs");
    assert.deepEqual(leaf.searchCatalog("  GHIDRA  "), ["Ghidra Notes"]);
    assert.deepEqual(leaf.searchCatalog("el"), []);
    assert.deepEqual(leaf.searchCatalog(null), []);
    report.fixtureGroundTruth = { normalizedLookup: true, shortQuery: true, nonStringQuery: true };
    const archive = path.join(root, "electron.asar");
    await asar.createPackageWithOptions(app, archive, { unpack: "preload.cjs" });
    report.archiveSha256 = digest(await readFile(archive));
    const missing = path.join(root, "missing-preload.asar");
    await cp(archive, missing);
    const targets = [
      ["directory", app],
      ["asar", archive],
      ["missing-companion", missing],
    ];
    for (const [id, target] of targets) {
      const { record, stdout } = await command(id, process.execPath, [
        entry,
        "analyze-javascript-application",
        target,
        "--format",
        "json",
      ]);
      if (record.exitCode === 0) {
        try {
          const evidence = JSON.parse(stdout);
          record.validation = validateApplication(evidence);
          record.evidenceId = evidence.evidence_id;
          record.statistics = evidence.normalized_result?.statistics;
          record.summary = evidence.normalized_result?.summary;
          record.limitations = evidence.normalized_result?.limitations;
          record.expectedPartial = id === "missing-companion";
          if (record.expectedPartial) {
            record.partialConfirmed =
              !record.validation.passed &&
              evidence.normalized_result?.graph.nodes.some(
                (node) =>
                  node.kind === "electron-preload" &&
                  node.observations.some(
                    (observation) =>
                      observation.properties.declared_path === "preload.cjs" &&
                      observation.properties.resolution_status === "not-found",
                  ),
              );
          } else {
            for (const [facet, view] of [
              ["summary", { kind: "summary" }],
              [
                "preload",
                { kind: "item", collection: "modules", selector: { path: "preload.cjs" } },
              ],
            ]) {
              const input = path.join(root, `${id}-${facet}.input.json`);
              await writeFile(
                input,
                JSON.stringify({ source: { kind: "inline", evidence }, view }),
              );
              const selected = await command(`${id}-${facet}`, process.execPath, [
                entry,
                "inspect-analysis-view",
                input,
                "--format",
                "json",
              ]);
              if (selected.record.exitCode === 0) {
                const projection = JSON.parse(selected.stdout);
                selected.record.parentMatches =
                  projection.normalized_result?.parent_evidence_id === evidence.evidence_id;
              } else if (facet === "preload") {
                const failure = JSON.parse(selected.stdout);
                const candidates = failure.details?.issues?.find(
                  (issue) => issue.path?.join(".") === "view.selector.path",
                )?.expected;
                selected.record.pathAmbiguityRefused =
                  failure.code === "invalid_request" && candidates?.length > 1;
                const asset = evidence.normalized_result.graph.nodes.find(
                  (node) =>
                    node.kind === "javascript-asset" &&
                    node.observations.some(
                      (observation) => observation.properties.path === "preload.cjs",
                    ),
                );
                if (
                  selected.record.pathAmbiguityRefused &&
                  candidates.some((candidate) => candidate.node_id === asset?.node_id)
                ) {
                  const exactInput = path.join(root, `${id}-preload-exact.input.json`);
                  await writeFile(
                    exactInput,
                    JSON.stringify({
                      source: { kind: "inline", evidence },
                      view: {
                        kind: "item",
                        collection: "modules",
                        selector: { node_id: asset.node_id },
                      },
                    }),
                  );
                  const exact = await command(`${id}-preload-exact`, process.execPath, [
                    entry,
                    "inspect-analysis-view",
                    exactInput,
                    "--format",
                    "json",
                  ]);
                  if (exact.record.exitCode === 0) {
                    exact.record.parentMatches =
                      JSON.parse(exact.stdout).normalized_result?.parent_evidence_id ===
                      evidence.evidence_id;
                  }
                }
              }
            }
          }
        } catch (failure) {
          record.validationError = failure.message;
        }
      }
      await save();
    }

    const native = path.join(root, "catalog");
    const build = await command("native-build", "gcc", [
      "-std=c11",
      "-O0",
      "-g",
      "-fno-inline",
      path.join(nativeSources, "catalog.c"),
      path.join(nativeSources, "driver.c"),
      "-o",
      native,
    ]);
    if (build.record.exitCode === 0) {
      report.nativeSha256 = digest(await readFile(native));
      for (const [query, expected] of nativeCases) {
        const observed = await command(`native-truth-${query}`, native, [query]);
        observed.record.passed = observed.record.exitCode === 0 && observed.stdout === expected;
        await save();
      }
      const readiness = await command("ghidra-readiness", process.execPath, [
        entry,
        "doctor",
        "--provider",
        "ghidra",
        "--format",
        "json",
      ]);
      try {
        const diagnostic = JSON.parse(readiness.stdout);
        report.ghidra = { healthy: diagnostic.healthy, checks: diagnostic.scope_checks };
        if (diagnostic.healthy === true) {
          const snapshot = path.join(root, "native-snapshot.json");
          const args = [
            entry,
            "function",
            native,
            "catalog_rank",
            "--provider",
            "ghidra",
            "--snapshot",
            snapshot,
            "--format",
            "json",
          ];
          const cold = await command("native-function-cold", process.execPath, args, 360000);
          if (cold.record.exitCode === 0) {
            const evidence = JSON.parse(cold.stdout);
            cold.record.validation = validateNative(evidence, report.nativeSha256);
            const cached = await command("native-function-cached", process.execPath, args, 360000);
            cached.record.sameOutput = cached.stdout === cold.stdout;
            if (cached.record.exitCode === 0) {
              const cachedEvidence = JSON.parse(cached.stdout);
              cached.record.sameEvidence = isDeepStrictEqual(evidence, cachedEvidence);
              cached.record.validation = validateNative(cachedEvidence, report.nativeSha256);
            }
            if (cold.record.validation.passed) {
              const reconstructed = path.join(root, "reconstructed.c");
              const recoveredBinary = path.join(root, "reconstructed");
              report.reconstruction = {
                evidenceId: evidence.evidence_id,
                prelude:
                  "#include <ctype.h>\n#include <string.h>\ntypedef unsigned int uint;\ntypedef unsigned char byte;\n",
                semanticEdits: 0,
              };
              await writeFile(
                reconstructed,
                report.reconstruction.prelude + evidence.normalized_result.pseudocode,
              );
              const compilation = await command("native-reconstruction-build", "gcc", [
                "-std=c11",
                "-O0",
                reconstructed,
                path.join(nativeSources, "driver.c"),
                "-o",
                recoveredBinary,
              ]);
              if (compilation.record.exitCode === 0) {
                for (const [query, expected] of nativeCases) {
                  const observed = await command(
                    `native-reconstruction-${query}`,
                    recoveredBinary,
                    [query],
                  );
                  observed.record.passed =
                    observed.record.exitCode === 0 && observed.stdout === expected;
                }
              }
            }
            await command(
              "native-search",
              process.execPath,
              [
                entry,
                "search",
                native,
                "catalog",
                "--kind",
                "procedures",
                "--provider",
                "ghidra",
                "--snapshot",
                snapshot,
                "--format",
                "json",
              ],
              360000,
            );
          }
        }
      } catch (failure) {
        if (report.ghidra) {
          report.nativeFailure = { message: failure.message };
        } else {
          report.ghidra = { healthy: false, diagnosticError: failure.message };
        }
      }
    }
    report.staticFixturePassed =
      ["directory", "asar"].every(
        (id) => records.find((record) => record.id === id)?.validation?.passed === true,
      ) && records.find((record) => record.id === "missing-companion")?.partialConfirmed === true;
    report.selectedViewsPassed = ["directory", "asar"].every((id) =>
      ["summary", "preload-exact"].every(
        (facet) => records.find((record) => record.id === `${id}-${facet}`)?.parentMatches === true,
      ),
    );
    report.nativeFixturePassed =
      records.find((record) => record.id === "native-function-cold")?.validation?.passed === true &&
      records.find((record) => record.id === "native-function-cached")?.sameEvidence === true &&
      nativeCases.every(
        ([query]) =>
          records.find((record) => record.id === `native-truth-${query}`)?.passed === true &&
          records.find((record) => record.id === `native-reconstruction-${query}`)?.passed === true,
      );
    report.finishedAt = new Date().toISOString();
  } catch (failure) {
    report.failure = { message: failure.message, stack: failure.stack };
    throw failure;
  } finally {
    await save();
  }
  return report;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [reaRoot, resultsRoot, ideRoot] = process.argv.slice(2);
  if (!reaRoot || !resultsRoot || !ideRoot) {
    throw new Error("Usage: node cli-baseline.mjs REA_PACKAGE_ROOT RESULTS_ROOT CURRENT_IDE_ROOT");
  }
  const report = await runBaseline({ reaRoot, resultsRoot, ideRoot });
  console.log(
    JSON.stringify(
      {
        root: report.root,
        ide: report.ide,
        rea: report.rea,
        staticFixturePassed: report.staticFixturePassed,
        selectedViewsPassed: report.selectedViewsPassed,
        nativeFixturePassed: report.nativeFixturePassed,
        nativeFailure: report.nativeFailure,
        ghidra: report.ghidra,
        records: report.records.map(
          ({
            id,
            exitCode,
            elapsedMs,
            stdoutBytes,
            validation,
            expectedPartial,
            partialConfirmed,
            parentMatches,
            passed,
          }) => ({
            id,
            exitCode,
            elapsedMs,
            stdoutBytes,
            validation,
            expectedPartial,
            partialConfirmed,
            parentMatches,
            passed,
          }),
        ),
      },
      null,
      2,
    ),
  );
}
