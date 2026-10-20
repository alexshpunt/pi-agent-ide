import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { testArtifactsDir } from "pi-coding-agent-test";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { runConnectorPreflight } from "#capabilities/preflight.ts";

test("free preflight binds actual Pi lifecycle with synthetic auth and network/host isolation", async () => {
  await withTempWorkspace(async (cwd) => {
    let networkRequests = 0;
    const server = createServer((_request, response) => {
      networkRequests++;
      response.end("HOST_ONLY");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing network fixture address");
      const stage = path.join(cwd, "stage");
      const packageRoot = path.join(stage, "node_modules/@benvargas/pi-claude-code-use");
      await mkdir(path.join(packageRoot, "extensions"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@benvargas/pi-claude-code-use",
          version: "2.2.1",
          type: "module",
          pi: { extensions: ["./extensions/index.ts"] },
        }),
      );
      await cp(
        path.resolve("tests/integration/fixtures/preflight-connector.ts"),
        path.join(packageRoot, "extensions/index.ts"),
      );
      const sentinel = path.join(cwd, "host-auth-sentinel");
      await writeFile(sentinel, "HOST_AUTH_UNCHANGED", { mode: 0o600 });
      await writeFile(
        path.join(packageRoot, "extensions/fixture-config.json"),
        JSON.stringify({ port: address.port, hostSentinel: sentinel }),
      );
      vi.stubEnv("ANTHROPIC_API_KEY", "HOST_ENV_MUST_NOT_REACH_CHILD");
      const result = await runConnectorPreflight(path.resolve("."), {
        connector: "benvargas",
        connectorRoot: stage,
        pi: process.env.PI_COMMAND ?? "/usr/bin/pi",
        timeoutMs: 120_000,
        results: path.join(testArtifactsDir(import.meta.filename), "load-" + randomUUID()),
      });
      expect(result.report.status, JSON.stringify(result.report.reasons)).toBe("loaded");
      expect(result.report).toMatchObject({
        inference: false,
        networkIsolated: true,
        syntheticCredentialsOnly: true,
      });
      expect(result.report.observed?.phases).toEqual([
        "loaded_factories",
        "session_start",
        "session_shutdown",
        "disposed",
      ]);
      expect(result.report.observed?.models.some((model) => model.id === "preflight-fixture")).toBe(
        true,
      );
      const names = result.report.observed?.tools.map((tool) => tool.name) ?? [];
      expect(names).toContain("preflight_network_blocked");
      expect(names).toContain("preflight_synthetic_auth");
      expect(names).toContain("preflight_ide_loaded");
      expect(names).not.toContain("preflight_host_leak");
      expect(names).not.toContain("preflight_env_leak");
      expect(result.report.observed?.activeTools).toContain("preflight_network_blocked");
      expect(result.report.observed?.shutdownTools).toContain("preflight_never_inferred");
      expect(result.report.observed?.shutdownTools).not.toContain("preflight_inference_leak");
      expect(
        result.report.observed?.tools.find((tool) => tool.name === "preflight_network_blocked")
          ?.sourceInfo,
      ).toMatchObject({
        path: "/connector/node_modules/@benvargas/pi-claude-code-use/extensions/index.ts",
      });
      expect(result.report.source?.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(networkRequests).toBe(0);
      expect(await readFile(sentinel, "utf8")).toBe("HOST_AUTH_UNCHANGED");
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}, 180_000);
