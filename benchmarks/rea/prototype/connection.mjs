import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
// oxlint-disable-next-line repo/no-parent-paths -- Reuse the baseline parser instead of duplicating the REA envelope contract.
import { mcpData } from "../mcp-data.mjs";

/** Open a pinned private REA connection, retaining raw research evidence without exposing its tool catalog.
 * @param {{reaRoot:string, packageVersion:string, entrySha256:string, resultsRoot:string, javaHome:string, ghidraRoot:string}} config
 * @param {AbortSignal} [signal]
 */
export async function connectRea(config, signal) {
  signal?.throwIfAborted();
  const entry = path.join(config.reaRoot, "scripts/rea.mjs");
  const manifest = JSON.parse(await readFile(path.join(config.reaRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, config.packageVersion, "REA package changed");
  assert.equal(
    createHash("sha256")
      .update(await readFile(entry))
      .digest("hex"),
    config.entrySha256,
    "REA entry changed",
  );
  const require = createRequire(path.join(config.reaRoot, "package.json"));
  const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/client")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio")).href
  );
  await mkdir(config.resultsRoot, { recursive: true });
  const root = await mkdtemp(path.join(config.resultsRoot, "resource-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(tmp)]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--mcp"],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      TMPDIR: tmp,
      JAVA_HOME: config.javaHome,
      GHIDRA_INSTALL_DIR: config.ghidraRoot,
    },
  });
  const client = new Client({ name: "lpt-709-private-resource", version: "1" });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  let sequence = 0;
  const call = async (name, args, requestSignal) => {
    requestSignal?.throwIfAborted();
    const id = `${String(++sequence).padStart(3, "0")}-${name}`;
    const request = { name, arguments: args };
    await writeFile(path.join(root, `${id}.request.json`), JSON.stringify(request, null, 2));
    try {
      const response = await client.callTool(request, {
        timeout: name === "close_binary" ? 30000 : 360000,
        maxTotalTimeout: name === "close_binary" ? 30000 : 360000,
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
      await writeFile(path.join(root, `${id}.response.json`), JSON.stringify(response, null, 2));
      const value = mcpData(response);
      if (response.isError) throw new Error(`REA ${name}: ${JSON.stringify(value)}`);
      requestSignal?.throwIfAborted();
      return value;
    } catch (failure) {
      await writeFile(
        path.join(root, `${id}.failure.json`),
        JSON.stringify({ message: failure.message, code: failure.code }, null, 2),
      );
      throw failure;
    }
  };
  const close = async () => {
    const pid = transport.pid;
    const failures = [];
    for (const action of [() => client.close(), () => transport.close()]) {
      try {
        await action();
      } catch (failure) {
        failures.push(failure);
      }
    }
    await writeFile(path.join(root, "server.stderr"), stderr);
    if (pid !== null && pid !== undefined) {
      let alive = null;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (failure) {
        if (failure.code === "ESRCH") alive = false;
        else failures.push(failure);
      }
      await writeFile(path.join(root, "transport-close.json"), JSON.stringify({ pid, alive }));
      if (alive === true)
        failures.push(new Error("REA server still exists after private transport close"));
    }
    if (failures.length)
      throw new AggregateError(failures, "REA private transport cleanup failed", {
        cause: failures[0],
      });
  };
  try {
    let abortConnect;
    const cancelled = new Promise((_, reject) => {
      abortConnect = () => reject(signal.reason);
      signal?.addEventListener("abort", abortConnect, { once: true });
    });
    try {
      signal?.throwIfAborted();
      await Promise.race([client.connect(transport), cancelled]);
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", abortConnect);
    }
    const session = await call(
      "binary_session",
      {
        expected_package_version: config.packageVersion,
        expected_server_path: entry,
      },
      signal,
    );
    const identity = session.result.server_identity;
    await writeFile(path.join(root, "identity.json"), JSON.stringify(identity, null, 2));
    return {
      call,
      close,
      root,
      identity: {
        package: identity.package,
        server: identity.server,
        sdk: identity.sdk,
        protocol: identity.negotiated_protocol_version,
        catalog: { counts: identity.catalog.counts, digests: identity.catalog.digests },
      },
    };
  } catch (failure) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [failure, cleanup],
        `${failure.message}; cleanup failed: ${cleanup.message}`,
        { cause: cleanup },
      );
    }
    throw failure;
  }
}
