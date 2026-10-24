import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { testArtifactsDir } from "pi-coding-agent-test";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { piRuntime } from "#capabilities/inventory.ts";
import { runProcess } from "#capabilities/sandbox.ts";

const connector = process.env.PI_AGENT_IDE_TEST_SUBSCRIPTION_CONNECTOR;
const ideTools = [
  "search",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "select",
  "undo",
  "diff",
];

interface Snapshot {
  system: string;
  tools: { name: string; description: string }[];
  wire: { system: string; tools: { name: string; description: string }[] };
  activeTools: string[];
  aliases: { name: string; exposure: string }[];
}

// The connector is an optional external prerequisite, never installed or fetched by the test.
test.skipIf(connector === undefined)(
  "the installed subscription connector declares IDE tools once and keeps direct and nested calls",
  async () => {
    await withTempWorkspace(async (cwd) => {
      const agentDir = path.join(cwd, "agent");
      const home = path.join(cwd, "home");
      const artifacts = path.join(
        testArtifactsDir(import.meta.filename),
        "subscription-alias-loadout",
      );
      await Promise.all([mkdir(agentDir), mkdir(home), mkdir(artifacts, { recursive: true })]);
      await writeFile(path.join(cwd, "note.txt"), "OLD\n");
      await writeFile(
        path.join(agentDir, "auth.json"),
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "SYNTHETIC_SUBSCRIPTION_ACCESS",
            refresh: "SYNTHETIC_SUBSCRIPTION_REFRESH",
            expires: Date.now() + 3_600_000,
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          defaultTools: ["read", "codemode", ...ideTools],
          codemode: { mode: "on" },
          retry: { enabled: false, maxRetries: 0 },
        }),
      );
      const runtime = await piRuntime();
      const result = await runProcess(
        process.execPath,
        [
          runtime.cli,
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
          "builtin:codemode",
          "-e",
          path.resolve(connector ?? ""),
          "-e",
          path.resolve("tests/integration/fixtures/subscription-alias-provider.ts"),
          "--model",
          "anthropic/subscription-alias-fixture",
          "--thinking",
          "off",
          "--exclude-tools",
          "edit,grep,find,ls",
          "--pi-agent-ide-no-post-processing",
          "true",
          "--",
          "Exercise direct and nested subscription aliases and their editing guide.",
        ],
        {
          cwd,
          timeoutMs: 90_000,
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
      const captured = await readFile(path.join(cwd, "subscription-alias-state.json"), "utf8");
      await writeFile(path.join(artifacts, "subscription-alias-state.json"), captured);
      const state = JSON.parse(captured) as { requests: number; snapshots: Snapshot[] };
      expect(result.timedOut).toBe(false);
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("SUBSCRIPTION_ALIAS_FIXTURE_OK");
      expect(result.stdout).toContain("# Precise text editing");
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("NESTED\n");
      expect(state.requests).toBe(3);
      for (const snapshot of state.snapshots) {
        expect(snapshot.activeTools).toContain("read");
        expect(snapshot.system).not.toContain("mcp__agent_ide__");
        expect(snapshot.system.match(/^- read:/gmu)).toHaveLength(1);
        expect(snapshot.tools.filter((tool) => tool.name === "read")).toHaveLength(1);
        expect(JSON.stringify(snapshot.tools)).not.toContain("mcp__agent_ide__");
        expect(snapshot.wire.tools.filter((tool) => tool.name === "read")).toHaveLength(1);
        for (const name of ideTools) {
          const alias = `mcp__agent_ide__${name}`;
          expect(snapshot.activeTools).toContain(alias);
          expect(snapshot.aliases.filter((tool) => tool.name === alias)).toEqual([
            expect.objectContaining({ exposure: "deferred" }),
          ]);
          expect(snapshot.system.match(new RegExp(`^- ${name}:`, "gmu"))).toHaveLength(1);
          expect(snapshot.tools.filter((tool) => tool.name === name)).toHaveLength(1);
          expect(snapshot.wire.tools.filter((tool) => tool.name === alias)).toHaveLength(1);
          expect(snapshot.wire.tools.some((tool) => tool.name === name)).toBe(false);
        }
        expect(snapshot.wire.system).not.toContain("mcp__agent_ide__");
      }
    });
  },
  120_000,
);
