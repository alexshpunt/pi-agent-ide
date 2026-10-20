import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  assertDedicatedAuthInvocation,
  stageDedicatedPiAuthentication,
} from "#capabilities/auth.ts";
import { runProcess, sandboxArgs } from "#capabilities/sandbox.ts";
import type { Provider } from "@earendil-works/pi-ai";
import { observeOAuthRefresh } from "#capabilities/auth-guard.ts";

const roots: string[] = [];
const initial = {
  type: "oauth",
  access: "SYNTHETIC_INITIAL_ACCESS",
  refresh: "SYNTHETIC_INITIAL_REFRESH",
  expires: 1,
};
const middle = {
  type: "oauth",
  access: "SYNTHETIC_MIDDLE_ACCESS",
  refresh: "SYNTHETIC_MIDDLE_REFRESH",
  expires: 1,
};
const rotated = {
  type: "oauth",
  access: "SYNTHETIC_ROTATED_ACCESS",
  refresh: "SYNTHETIC_ROTATED_REFRESH",
  expires: Date.now() + 3_600_000,
};
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/dedicated-auth-test-"));
  roots.push(root);
  const dedicated = path.join(root, "dedicated");
  const state = path.join(root, "state");
  await mkdir(dedicated, { mode: 0o700 });
  const auth = path.join(dedicated, "auth.json");
  await writeFile(auth, JSON.stringify({ fixture: initial }), { mode: 0o600 });
  return { root, dedicated, state, auth };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([
  { args: ["--dedicated-auth"] },
  { args: ["--run", "--dedicated-auth"] },
  { args: ["--preflight", "--run", "--dedicated-auth", "--auth-dir", "/private"] },
])("dedicated refresh rejects incomplete or free invocation $args", ({ args }) => {
  expect(() => assertDedicatedAuthInvocation(args)).toThrow("--dedicated-auth requires");
});
test("dedicated refresh is explicit and cannot silently enable CLI refresh", () => {
  const args = ["--run", "--dedicated-auth", "--auth-dir", "/private"];
  expect(() => assertDedicatedAuthInvocation(args, "pi")).not.toThrow();
  expect(() => assertDedicatedAuthInvocation(args, "claude")).toThrow("CLI");
  expect(() => assertDedicatedAuthInvocation(args, "separate")).toThrow("CLI");
  expect(() => assertDedicatedAuthInvocation(["--check"])).not.toThrow();
});
test("dedicated staging permits expiry but mounts only the selected owned auth file", async () => {
  const f = await fixture();
  const staged = await stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated);
  try {
    expect(staged.policy).toEqual({ provider: "fixture", expiresAt: 1, refreshAllowed: true });
    expect(staged.environment).toEqual({});
    expect(staged.mount).toEqual({ source: f.auth, target: "/state/agent/auth.json" });
    expect(await readFile(f.auth, "utf8")).toBe(JSON.stringify({ fixture: initial }));
    await expect(
      stageDedicatedPiAuthentication(path.join(f.root, "other"), "fixture", f.dedicated),
    ).rejects.toThrow("already in use");
  } finally {
    await staged.release?.();
  }
  const next = await stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated);
  await next.release?.();
});
test.each(["mode", "hardlink", "symlink", "other-provider"] as const)(
  "dedicated refresh rejects unsafe %s auth files",
  async (kind) => {
    const f = await fixture();
    if (kind === "mode") await chmod(f.auth, 0o644);
    if (kind === "hardlink") await link(f.auth, path.join(f.root, "other-auth.json"));
    if (kind === "symlink") {
      const target = path.join(f.root, "other-auth.json");
      await writeFile(target, JSON.stringify({ fixture: initial }), { mode: 0o600 });
      await rm(f.auth);
      await symlink(target, f.auth);
    }
    if (kind === "other-provider")
      await writeFile(f.auth, JSON.stringify({ fixture: initial, unrelated: initial }));
    await expect(stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated)).rejects.toThrow(
      /private|selected/u,
    );
    await expect(readFile(path.join(f.state, "agent/auth.json"))).rejects.toThrow("ENOENT");
  },
);
test("dedicated refresh rejects personal auth directories before reading credentials", async () => {
  const f = await fixture();
  await expect(stageDedicatedPiAuthentication(f.state, "fixture", os.homedir())).rejects.toThrow(
    "personal",
  );
});
test("the dedicated wrapper permits refresh and audits it without modifying the original provider", async () => {
  const f = await fixture();
  const staged = await stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated);
  let refreshCalls = 0;
  const original: Provider = {
    id: "fixture",
    name: "Fixture",
    getModels: () => [],
    stream: () => {
      throw new Error("No inference");
    },
    streamSimple: () => {
      throw new Error("No inference");
    },
    auth: {
      oauth: {
        name: "Fixture OAuth",
        login: async () => {
          throw new Error("No login");
        },
        refresh: async () => {
          refreshCalls++;
          return { ...rotated, type: "oauth" };
        },
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  };
  try {
    const audit = path.join(f.state, "auth-secrets.jsonl");
    const provider = observeOAuthRefresh(original, audit);
    expect(provider.auth.oauth?.refresh).not.toBe(original.auth.oauth?.refresh);
    expect(observeOAuthRefresh(provider, audit)).toBe(provider);
    await provider.auth.oauth?.refresh({ ...initial, type: "oauth" }, new AbortController().signal);
    expect(refreshCalls).toBe(1);
    expect(JSON.parse((await readFile(audit, "utf8")).trim())).toEqual(rotated);
  } finally {
    await staged.release?.();
  }
});
test("redaction learns every rotation, not just the final credential", async () => {
  const f = await fixture();
  const staged = await stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated);
  try {
    await writeFile(
      path.join(f.state, "auth-secrets.jsonl"),
      [middle, rotated].map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
    await writeFile(f.auth, JSON.stringify({ fixture: rotated }));
    await staged.refreshSecrets?.();
    for (const credential of [initial, middle, rotated]) {
      for (const secret of [credential.access, credential.refresh]) {
        expect(staged.containsSecret(secret)).toBe(true);
        expect(staged.redact(`error ${secret}`)).toBe("error [REDACTED_AUTH_TOKEN]");
      }
    }
    expect(JSON.stringify(staged.policy)).not.toContain(initial.access);
  } finally {
    await staged.release?.();
  }
});
test("a malformed rotation audit fails closed before exporting output", async () => {
  const f = await fixture();
  const staged = await stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated);
  try {
    await writeFile(path.join(f.state, "auth-secrets.jsonl"), '{"access":"SECRET');
    await expect(staged.refreshSecrets?.()).rejects.toThrow("output must not be retained");
  } finally {
    await staged.release?.();
  }
});
test("a timed-out child preserves a completed rotation without exposing the containing private directory", async () => {
  const f = await fixture();
  const source = path.join(f.root, "source");
  await mkdir(source);
  await mkdir(path.join(f.root, "workspace/fixture"), { recursive: true });
  await writeFile(path.join(f.dedicated, "settings-sentinel"), "DO_NOT_MOUNT");
  const staged = await stageDedicatedPiAuthentication(f.state, "fixture", f.dedicated);
  try {
    const args = await sandboxArgs(source, f.root);
    if (!staged.mount) throw new Error("Missing dedicated credential mount");
    args.splice(-1, 0, "--bind", staged.mount.source, staged.mount.target);
    const script = `const fs=require("node:fs");fs.writeFileSync("/state/agent/auth.json",JSON.stringify({fixture:${JSON.stringify(rotated)}}));console.log(fs.existsSync("${f.dedicated}/settings-sentinel"));setInterval(()=>{},1000);`;
    const run = await runProcess("bwrap", [...args, "/usr/bin/node", "-e", script], {
      timeoutMs: 1000,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(run.timedOut).toBe(true);
    expect(run.stdout.trim()).toBe("false");
    await staged.refreshSecrets?.();
    expect(JSON.parse(await readFile(f.auth, "utf8"))).toEqual({ fixture: rotated });
    await rm(f.state, { recursive: true });
    expect(JSON.parse(await readFile(f.auth, "utf8"))).toEqual({ fixture: rotated });
  } finally {
    await staged.release?.();
  }
}, 15_000);
