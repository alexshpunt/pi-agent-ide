import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { validateApplication } from "./validate-js.mjs";
import { validateNative } from "./validate-native.mjs";
import { mcpData } from "./mcp-data.mjs";

const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function ownedProcessTree(parentPid) {
  const { stdout } = await execute("ps", ["-eo", "pid=,ppid=,pgid=,comm=,args="]);
  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      assert.ok(match, "Malformed process observation");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        name: match[4],
        command: match[5],
      };
    });
  const owners = new Set([parentPid]);
  const children = [];
  for (let depth = 0; depth < 8; depth++) {
    const next = processes.filter((entry) => owners.has(entry.parent) && !owners.has(entry.pid));
    if (next.length === 0) return children;
    for (const entry of next) {
      owners.add(entry.pid);
      children.push(entry);
    }
  }
  throw new Error("Owned process tree exceeded this probe's depth limit");
}
async function processStates(pids) {
  assert.equal(process.platform, "linux", "This process cleanup probe requires Linux /proc");
  return Promise.all(
    pids.map(async (pid) => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/);
        assert.match(fields[19], /^\d+$/, "Missing process start identity");
        return { pid, exists: true, startTicks: fields[19], group: Number(fields[2]) };
      } catch (failure) {
        if (failure.code !== "ENOENT") throw failure;
        return { pid, exists: false };
      }
    }),
  );
}

/** Measure one private REA connection without a Pi extension or any model calls. */
export async function runMcpBaseline({
  reaRoot,
  cliRun,
  resultsRoot,
  ideRoot,
  cancelImport = false,
}) {
  reaRoot = path.resolve(reaRoot);
  cliRun = path.resolve(cliRun);
  ideRoot = path.resolve(ideRoot);
  await execute("git", ["-C", ideRoot, "fetch", "origin", "develop"]);
  const revision = async (ref) =>
    (await execute("git", ["-C", ideRoot, "rev-parse", ref])).stdout.trim();
  const commit = await revision("HEAD");
  assert.equal(commit, await revision("origin/develop"));
  const idePackage = JSON.parse(await readFile(path.join(ideRoot, "package.json"), "utf8"));
  const cliReport = JSON.parse(await readFile(path.join(cliRun, "result.json"), "utf8"));
  const reaPackage = JSON.parse(await readFile(path.join(reaRoot, "package.json"), "utf8"));
  assert.equal(process.env.GHIDRA_INSTALL_DIR, cliReport.nativeTools?.ghidraRoot);
  assert.equal(process.env.JAVA_HOME, cliReport.nativeTools?.javaHome);
  assert.equal(reaPackage.version, cliReport.rea.version);
  const requireRea = createRequire(path.join(reaRoot, "package.json"));
  const { Client } = await import(
    pathToFileURL(requireRea.resolve("@modelcontextprotocol/client")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(requireRea.resolve("@modelcontextprotocol/client/stdio")).href
  );
  await mkdir(resultsRoot, { recursive: true });
  const root = await mkdtemp(path.join(path.resolve(resultsRoot), "mcp-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(tmp)]);
  const native = path.join(root, "catalog");
  const app = path.join(root, "electron");
  await Promise.all([
    cp(path.join(cliRun, "catalog"), native),
    cp(path.join(cliRun, "electron"), app, { recursive: true }),
  ]);
  assert.equal(digest(await readFile(native)), cliReport.nativeSha256);
  const entry = path.join(reaRoot, "scripts", "rea.mjs");
  assert.equal(digest(await readFile(entry)), cliReport.rea.entrySha256);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--mcp"],
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      TMPDIR: tmp,
      JAVA_HOME: process.env.JAVA_HOME,
      GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "lpt-709-no-model-baseline", version: "1" });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const records = [];
  const report = {
    kind: "deterministic-mcp-baseline",
    startedAt: new Date().toISOString(),
    root,
    cliRun,
    ide: { source: ideRoot, version: idePackage.version, commit, piChildLaunched: false },
    rea: { version: reaPackage.version, entrySha256: digest(await readFile(entry)) },
    nativeTools: cliReport.nativeTools,
    runnerSha256: digest(await readFile(fileURLToPath(import.meta.url))),
    modelCalls: 0,
    records,
  };
  const save = async () => {
    await Promise.all([
      writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2) + "\n"),
      writeFile(path.join(root, "server.stderr"), stderr),
    ]);
  };
  const call = async (id, name, args = {}, expectedError = false, options = {}) => {
    const request = { name, arguments: args };
    const record = { id, request, expectedError };
    records.push(record);
    await writeFile(path.join(root, `${id}.request.json`), JSON.stringify(request, null, 2));
    const started = performance.now();
    try {
      const response = await client.callTool(request, {
        timeout: 360000,
        maxTotalTimeout: 360000,
        ...options,
      });
      const serialized = JSON.stringify(response, null, 2);
      await writeFile(path.join(root, `${id}.response.json`), serialized);
      record.elapsedMs = Math.round(performance.now() - started);
      record.responseBytes = Buffer.byteLength(serialized);
      record.isError = response.isError === true;
      await save();
      assert.equal(record.isError, expectedError, `${id} unexpected tool status`);
      return mcpData(response);
    } catch (failure) {
      record.elapsedMs = Math.round(performance.now() - started);
      record.exception = { name: failure.name, message: failure.message, code: failure.code };
      await save();
      throw failure;
    }
  };
  const harness = path.join(root, "harness");
  await mkdir(harness);
  for (const file of [
    "mcp-baseline.mjs",
    "mcp-data.mjs",
    "validate-js.mjs",
    "validate-native.mjs",
  ]) {
    await cp(fileURLToPath(new URL(file, import.meta.url)), path.join(harness, file));
  }
  await save();
  try {
    const started = performance.now();
    await client.connect(transport);
    report.connectMs = Math.round(performance.now() - started);
    report.serverPid = transport.pid;
    const catalog = await client.listTools();
    await writeFile(path.join(root, "tools.json"), JSON.stringify(catalog, null, 2));
    report.toolCount = catalog.tools.length;
    const empty = await call("session-empty", "binary_session", {
      expected_package_version: reaPackage.version,
      expected_server_path: entry,
    });
    const identity = empty.result.server_identity;
    report.serverIdentity = {
      package: identity.package,
      server: identity.server,
      sdk: identity.sdk,
      protocol: identity.negotiated_protocol_version,
      catalog: { counts: identity.catalog.counts, digests: identity.catalog.digests },
    };
    assert.equal(empty.result.open, false);
    const application = await call("application", "analyze_javascript_application", {
      input_path: app,
    });
    report.applicationValidation = validateApplication(application);
    assert.equal(report.applicationValidation.passed, true);
    const source = { kind: "retained-evidence", evidence_id: application.evidence_id };
    const selected = await call("retained-summary", "inspect_analysis_view", {
      source,
      view: { kind: "summary" },
    });
    report.retainedParentMatches =
      selected.normalized_result.parent_evidence_id === application.evidence_id;
    await call("open-native", "open_binary", { path: native, provider_id: "ghidra" });
    await call("session-native", "binary_session");
    const dossier = await call("function-cold", "analyze_function", { procedure: "catalog_rank" });
    report.nativeValidation = validateNative(dossier, cliReport.nativeSha256);
    assert.equal(report.nativeValidation.passed, true);
    const repeated = await call("function-repeated", "analyze_function", {
      procedure: "catalog_rank",
    });
    report.repeatedEvidenceMatches = isDeepStrictEqual(dossier, repeated);
    report.repeatedNormalizedMatches = isDeepStrictEqual(
      dossier.normalized_result,
      repeated.normalized_result,
    );
    report.repeatedValidation = validateNative(repeated, cliReport.nativeSha256);
    assert.equal(report.repeatedNormalizedMatches, true);
    assert.equal(report.repeatedValidation.passed, true);
    await call("search-new-query", "search_procedures", { pattern: "catalog" });
    const analyzed = await call("session-analyzed", "binary_session");
    const lineage = analyzed.result.analysis_run.process_lineage.snapshots.find(
      (snapshot) => snapshot.provider.id === "ghidra" && snapshot.observation.status === "verified",
    )?.observation;
    assert.ok(lineage, "Missing verified Ghidra process lineage");
    assert.equal(lineage.launcher_parent_pid, report.serverPid);
    const providerPids = [lineage.launcher_pid, ...lineage.descendants.map((child) => child.pid)];
    report.providerBeforeClose = await processStates(providerPids);
    assert.ok(
      report.providerBeforeClose.every(
        (state) => state.exists === true && state.group === lineage.process_group_id,
      ),
    );
    await call("retained-after-open", "inspect_analysis_view", {
      source,
      view: { kind: "summary" },
    });
    await call("close-native", "close_binary");
    report.providerAfterClose = await processStates(providerPids);
    report.providerCleanupVerified = report.providerBeforeClose.every((before, index) => {
      const after = report.providerAfterClose[index];
      return after.exists === false || after.startTicks !== before.startTicks;
    });
    assert.equal(report.providerCleanupVerified, true);
    const missing = await call(
      "retained-after-close",
      "inspect_analysis_view",
      { source, view: { kind: "summary" } },
      true,
    );
    report.missingAfterClose = missing;
    assert.equal(missing.code, "evidence_integrity_mismatch");
    assert.equal(missing.details.reason, "missing");
    assert.equal(missing.details.evidence_id, application.evidence_id);
    const closed = await call("session-closed", "binary_session");
    assert.equal(closed.result.open, false);
    if (cancelImport) {
      await call("open-for-cancellation", "open_binary", { path: native, provider_id: "ghidra" });
      const controller = new AbortController();
      let requestSettled = false;
      const pending = call(
        "function-cancelled",
        "analyze_function",
        { procedure: "catalog_rank" },
        false,
        {
          signal: controller.signal,
        },
      )
        .then(
          (data) => {
            requestSettled = true;
            return { kind: "completed", evidenceId: data.evidence_id };
          },
          (failure) => ({
            kind: "rejected",
            requestSettledBeforeAbort: !controller.signal.aborted,
            clientAborted: controller.signal.aborted,
            name: failure.name,
            message: failure.message,
            code: failure.code,
          }),
        )
        .finally(() => {
          requestSettled = true;
        });
      await sleep(8000);
      const during = await call("session-during-cancellation", "binary_session");
      report.cancellation = {
        before: during.result.analysis_activity,
        processLineage: during.result.analysis_run.process_lineage,
      };
      report.cancellation.ownedProcesses = await ownedProcessTree(report.serverPid);
      report.cancellation.processesBefore = await processStates(
        report.cancellation.ownedProcesses.map((entry) => entry.pid),
      );
      report.cancellation.pendingAtAbort = !requestSettled;
      report.cancellation.providerObserved = report.cancellation.ownedProcesses.some(
        (entry) => entry.name === "java" && entry.command.includes(process.env.GHIDRA_INSTALL_DIR),
      );
      assert.equal(report.cancellation.pendingAtAbort, true);
      assert.equal(report.cancellation.providerObserved, true);
      controller.abort(new Error("Cancel this owned fixture import"));
      report.cancellation.clientResult = await pending;
      assert.equal(report.cancellation.clientResult.kind, "rejected");
      assert.equal(report.cancellation.clientResult.clientAborted, true);
      const after = await call("session-after-cancellation", "binary_session");
      report.cancellation.after = after.result.analysis_activity;
      assert.equal(after.result.open, true);
      const recovered = await call("function-after-cancellation", "analyze_function", {
        procedure: "catalog_rank",
      });
      report.cancellation.recovery = validateNative(recovered, cliReport.nativeSha256);
      report.cancellation.processesAfterRecovery = await processStates(
        report.cancellation.ownedProcesses.map((entry) => entry.pid),
      );
      report.cancellation.originalProcessesGone = report.cancellation.processesBefore.every(
        (before, index) => {
          const after = report.cancellation.processesAfterRecovery[index];
          return (
            before.exists === false ||
            after.exists === false ||
            before.startTicks !== after.startTicks
          );
        },
      );
      assert.equal(report.cancellation.recovery.passed, true);
      await call("close-after-cancellation", "close_binary");
      const finished = await call("session-after-cancellation-close", "binary_session");
      assert.equal(finished.result.open, false);
    }
    report.finishedAt = new Date().toISOString();
  } catch (failure) {
    report.failure = { name: failure.name, message: failure.message };
    throw failure;
  } finally {
    const started = performance.now();
    try {
      await client.close();
      await transport.close();
      report.closeMs = Math.round(performance.now() - started);
      if (report.providerBeforeClose) {
        report.providerAfterTransportClose = await processStates(
          report.providerBeforeClose.map((state) => state.pid),
        );
      }
      try {
        process.kill(report.serverPid, 0);
        report.serverStillAlive = true;
      } catch (failure) {
        if (failure.code === "ESRCH") {
          report.serverStillAlive = false;
        } else {
          report.serverStillAlive = null;
          report.cleanupError = { name: failure.name, message: failure.message };
        }
      }
    } catch (failure) {
      report.cleanupError = { name: failure.name, message: failure.message };
    }
    await save();
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [reaRoot, cliRun, resultsRoot, ideRoot, mode] = process.argv.slice(2);
  assert.ok(mode === undefined || mode === "--cancel-import", "Unknown baseline mode");
  if (!reaRoot || !cliRun || !resultsRoot || !ideRoot) {
    throw new Error(
      "Usage: node mcp-baseline.mjs REA_PACKAGE_ROOT CLI_RUN RESULTS_ROOT CURRENT_IDE_ROOT",
    );
  }
  const report = await runMcpBaseline({
    reaRoot,
    cliRun,
    resultsRoot,
    ideRoot,
    cancelImport: mode === "--cancel-import",
  });
  console.log(JSON.stringify(report, null, 2));
}
