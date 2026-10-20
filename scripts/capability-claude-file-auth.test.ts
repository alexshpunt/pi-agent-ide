import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Provider } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { stageDedicatedClaudeFileAuthentication } from "#capabilities/auth.ts";
import { observeClaudeFileAuthentication } from "#capabilities/auth-guard.ts";
import {
  connectorCatalog,
  stageConnectorState,
  type PreparedConnector,
} from "#capabilities/connectors.ts";
import { runProcess, sandboxArgs } from "#capabilities/sandbox.ts";

const roots: string[] = [];
const initial = {
  accessToken: "SYNTHETIC_CLAUDE_INITIAL_ACCESS",
  refreshToken: "SYNTHETIC_CLAUDE_INITIAL_REFRESH",
  expiresAt: 1,
};
const middle = {
  accessToken: "SYNTHETIC_CLAUDE_MIDDLE_ACCESS",
  refreshToken: "SYNTHETIC_CLAUDE_MIDDLE_REFRESH",
  expiresAt: Date.now() + 3_600_000,
};
const next = {
  accessToken: "SYNTHETIC_CLAUDE_FINAL_ACCESS",
  refreshToken: "SYNTHETIC_CLAUDE_FINAL_REFRESH",
  expiresAt: Date.now() + 3_600_000,
};
const piCredential = (value: typeof initial) => ({
  type: "oauth" as const,
  access: value.accessToken,
  refresh: value.refreshToken,
  expires: value.expiresAt,
});
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/claude-file-auth-test-"));
  roots.push(root);
  const dedicated = path.join(root, "dedicated");
  await mkdir(dedicated, { mode: 0o700 });
  const file = path.join(dedicated, ".credentials.json");
  await writeFile(file, JSON.stringify({ claudeAiOauth: initial }), { mode: 0o600 });
  const state = path.join(root, "state");
  return { root, dedicated, file, state };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("only pinned claude-auth selects dedicated file auth and staging does not expose token env", async () => {
  expect(
    connectorCatalog
      .filter((entry) => entry.claudeFileAuth)
      .map((entry) => [entry.id, entry.version]),
  ).toEqual([["claude-auth", "0.1.3"]]);
  const f = await fixture();
  const definition = connectorCatalog.find((entry) => entry.id === "claude-auth");
  if (!definition) throw new Error("Missing pinned connector");
  const connector: PreparedConnector = {
    definition,
    root: f.root,
    extensions: [],
    packagePath: "/connector",
    metadata: {
      id: definition.id,
      package: definition.package,
      version: definition.version,
      digest: "fixture",
    },
  };
  const auth = await stageConnectorState(connector, f.state, { claudeState: f.dedicated }, 1000);
  try {
    expect(auth.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(auth.policy.refreshAllowed).toBe(true);
    expect(auth.mount).toEqual({ source: f.file, target: "/state/home/.claude/.credentials.json" });
    expect(await readFile(path.join(f.state, "agent/auth.json"), "utf8")).toBe("{}");
    await expect(
      stageDedicatedClaudeFileAuthentication(path.join(f.root, "other"), "anthropic", f.dedicated),
    ).rejects.toThrow("already in use");
  } finally {
    await auth.release?.();
  }
  const again = await stageDedicatedClaudeFileAuthentication(f.state, "anthropic", f.dedicated);
  await again.release?.();
});

test.each([
  "file-mode",
  "dir-mode",
  "hardlink",
  "symlink",
  "directory-symlink",
  "extra-provider",
  "missing-refresh",
] as const)("file auth rejects unsafe %s", async (kind) => {
  const f = await fixture();
  let directory = f.dedicated;
  if (kind === "file-mode") await chmod(f.file, 0o644);
  if (kind === "dir-mode") await chmod(f.dedicated, 0o755);
  if (kind === "hardlink") await link(f.file, path.join(f.root, "other"));
  if (kind === "symlink") {
    await rm(f.file);
    const other = path.join(f.root, "other");
    await writeFile(other, "{}");
    await symlink(other, f.file);
  }
  if (kind === "directory-symlink") {
    directory = path.join(f.root, "link");
    await symlink(f.dedicated, directory);
  }
  if (kind === "extra-provider")
    await writeFile(
      f.file,
      JSON.stringify({ claudeAiOauth: initial, unrelated: { accessToken: "DO_NOT_SHARE" } }),
    );
  if (kind === "missing-refresh")
    await writeFile(
      f.file,
      JSON.stringify({ claudeAiOauth: { accessToken: initial.accessToken, expiresAt: 1 } }),
    );
  await expect(
    stageDedicatedClaudeFileAuthentication(f.state, "anthropic", directory),
  ).rejects.toThrow(/private|symlink|OAuth|access token/u);
  await expect(readFile(path.join(f.state, "agent/auth.json"))).rejects.toThrow("ENOENT");
});

test("personal or wrong-provider file auth rejects before exposing credentials", async () => {
  const f = await fixture();
  await expect(
    stageDedicatedClaudeFileAuthentication(f.state, "anthropic", os.homedir()),
  ).rejects.toThrow("personal");
  await expect(
    stageDedicatedClaudeFileAuthentication(f.state, "other", f.dedicated),
  ).rejects.toThrow("Anthropic");
});

test("public auth boundaries audit intermediate file and seeded Pi rotations, including failures", async () => {
  const f = await fixture();
  const auth = await stageDedicatedClaudeFileAuthentication(f.state, "anthropic", f.dedicated);
  const audit = path.join(f.state, "auth-secrets.jsonl");
  let inference = 0;
  const provider: Provider = {
    id: "anthropic",
    name: "Synthetic file auth",
    getModels: () => [],
    stream: () => {
      inference++;
      throw new Error("Forbidden inference");
    },
    streamSimple: () => {
      inference++;
      throw new Error("Forbidden inference");
    },
    auth: {
      oauth: {
        name: "Synthetic",
        login: async () => {
          throw new Error("No login");
        },
        refresh: async () => {
          writeFileSync(f.file, JSON.stringify({ claudeAiOauth: next }));
          writeFileSync(
            path.join(f.state, "agent/auth.json"),
            JSON.stringify({ anthropic: piCredential(next) }),
          );
          throw new Error("Synthetic failure after rotation");
        },
        toAuth: async () => {
          writeFileSync(f.file, JSON.stringify({ claudeAiOauth: middle }));
          writeFileSync(
            path.join(f.state, "agent/auth.json"),
            JSON.stringify({ anthropic: piCredential(middle) }),
          );
          return { apiKey: middle.accessToken };
        },
      },
    },
  };
  try {
    const observed = observeClaudeFileAuthentication(provider, audit, f.file);
    expect(observeClaudeFileAuthentication(observed, audit, f.file)).toBe(observed);
    await observed.auth.oauth?.toAuth(piCredential(initial));
    await expect(
      observed.auth.oauth?.refresh(piCredential(initial), new AbortController().signal),
    ).rejects.toThrow("Synthetic failure");
    await auth.refreshSecrets?.();
    expect(inference).toBe(0);
    for (const value of [initial, middle, next])
      for (const secret of [value.accessToken, value.refreshToken])
        expect(auth.redact(secret)).toBe("[REDACTED_AUTH_TOKEN]");
    expect(JSON.stringify(auth.policy)).not.toContain(initial.accessToken);
  } finally {
    await auth.release?.();
  }
});

test("sandbox blocks CLI fallback without inference and reports the attempt", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "workspace/fixture"), { recursive: true });
  const source = path.join(f.root, "source");
  const connector = path.join(f.root, "connector");
  await mkdir(source);
  await mkdir(connector);
  await writeFile(path.join(f.dedicated, "unrelated-settings"), "DO_NOT_MOUNT");
  const args = await sandboxArgs(source, f.root, {
    root: connector,
    definition: { claudeFileAuth: true },
  });
  const auth = await stageDedicatedClaudeFileAuthentication(f.state, "anthropic", f.dedicated);
  try {
    if (!auth.mount) throw new Error("Missing credential mount");
    args.splice(-1, 0, "--bind", auth.mount.source, auth.mount.target);
    const script = `const fs=require('node:fs'), cp=require('node:child_process');let code;try{cp.execSync('claude -p . --model haiku',{stdio:'ignore'})}catch(e){code=e.status}console.log(JSON.stringify({code,marker:fs.readFileSync('/state/claude-fallback-attempted','utf8'),unrelated:fs.existsSync('/state/home/.claude/unrelated-settings')}));`;
    const run = await runProcess("bwrap", [...args, process.execPath, "-e", script], {
      env: { PATH: "/tools:/usr/bin:/bin", HOME: "/state/home" },
      timeoutMs: 3000,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ code: 126, marker: "blocked\n", unrelated: false });
    await expect(auth.refreshSecrets?.()).rejects.toThrow("blocked Claude CLI fallback inference");
  } finally {
    await auth.release?.();
  }
});

test("a timed-out child preserves completed file rotations in only the dedicated file", async () => {
  const f = await fixture();
  const source = path.join(f.root, "source");
  await mkdir(source);
  await mkdir(path.join(f.root, "workspace/fixture"), { recursive: true });
  const auth = await stageDedicatedClaudeFileAuthentication(f.state, "anthropic", f.dedicated);
  try {
    const args = await sandboxArgs(source, f.root);
    if (!auth.mount) throw new Error("Missing credential mount");
    args.splice(-1, 0, "--bind", auth.mount.source, auth.mount.target);
    const script = `require('node:fs').writeFileSync('/state/home/.claude/.credentials.json',${JSON.stringify(JSON.stringify({ claudeAiOauth: next }))});setInterval(()=>{},1000);`;
    const run = await runProcess("bwrap", [...args, process.execPath, "-e", script], {
      timeoutMs: 1000,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(run.timedOut).toBe(true);
    await auth.refreshSecrets?.();
    await rm(f.state, { recursive: true });
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ claudeAiOauth: next });
  } finally {
    await auth.release?.();
  }
}, 10_000);
