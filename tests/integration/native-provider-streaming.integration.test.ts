import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { testArtifactsDir } from "pi-coding-agent-test";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { runProcess } from "#capabilities/sandbox.ts";

// Startup and native provider registration are the contract, so use the installed CLI directly.
test("native OAuth survives streaming guard installation, provider rebinding and shutdown", async () => {
  await withTempWorkspace(async (cwd) => {
    const agentDir = path.join(cwd, "agent");
    const home = path.join(cwd, "home");
    const artifacts = path.join(
      testArtifactsDir(import.meta.filename),
      "native-oauth-registration",
    );
    await Promise.all([mkdir(agentDir), mkdir(home), mkdir(artifacts, { recursive: true })]);
    await writeFile(path.join(cwd, "note.txt"), "OLD\n");
    await writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        "native-oauth-stream-fixture": {
          type: "oauth",
          access: "SYNTHETIC_NATIVE_ACCESS",
          refresh: "SYNTHETIC_NATIVE_REFRESH",
          expires: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultTools: ["replace", "read"],
        retry: { enabled: false, maxRetries: 0 },
      }),
    );
    const result = await runProcess(
      "/usr/bin/pi",
      [
        "--approve",
        "--offline",
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--no-mcp",
        "-e",
        path.resolve("src/pi-agent-ide.ts"),
        "-e",
        path.resolve("tests/integration/fixtures/native-oauth-stream-provider.ts"),
        "--model",
        "native-oauth-stream-fixture/fixture",
        "--thinking",
        "off",
        "--exclude-tools",
        "edit,grep,find,ls",
        "--pi-agent-ide-no-post-processing",
        "true",
        "--",
        "Replace OLD with NEW using the native fixture provider.",
      ],
      {
        cwd,
        timeoutMs: 120_000,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_SKIP_VERSION_CHECK: "1",
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
        },
      },
    );
    await writeFile(path.join(artifacts, "stdout.jsonl"), result.stdout);
    await writeFile(path.join(artifacts, "stderr.log"), result.stderr);
    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("NATIVE_OAUTH_STREAM_OK");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("NEW\n");
    const stateText = await readFile(path.join(cwd, "native-provider-state.json"), "utf8");
    await writeFile(path.join(artifacts, "native-provider-state.json"), stateText);
    const state: unknown = JSON.parse(stateText);
    if (
      !state ||
      typeof state !== "object" ||
      !("authResolutions" in state) ||
      typeof state.authResolutions !== "number"
    )
      throw new Error("The native OAuth fixture did not report authentication resolution");
    expect(state.authResolutions).toBeGreaterThan(0);
    expect(state).toMatchObject({
      requests: 2,
      rebound: true,
    });
    expect(state).toMatchObject({
      snapshots: [
        { phase: "start", oauth: true, models: true, restored: false },
        { phase: "request", oauth: true, models: true, restored: false },
        {
          phase: "request",
          oauth: true,
          models: true,
          restored: false,
          name: "Rebound native fixture",
        },
        {
          phase: "shutdown",
          oauth: true,
          models: true,
          restored: true,
          name: "Rebound native fixture",
        },
      ],
    });
  });
}, 150_000);
