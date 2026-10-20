import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createModels,
  type Credential,
  type CredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import {
  assertAuthLifetime,
  OAUTH_REFRESH_WINDOW_MS,
  stageClaudeAuthentication,
  stagePiAuthentication,
} from "#capabilities/auth.ts";
import { applyAuthenticationPolicy, withoutOAuthRefresh } from "#capabilities/auth-guard.ts";

const roots: string[] = [];
const access = "sk-ant-oat01-SYNTHETIC-ACCESS";
const refresh = "SYNTHETIC_REFRESH_MUST_NOT_REACH_CHILD";
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/auth-policy-test-"));
  roots.push(root);
  const snapshot = path.join(root, "snapshot");
  await mkdir(snapshot);
  return { root, snapshot, state: path.join(root, "state") };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("expiry must cover the complete bounded attempt and Pi's early refresh window", () => {
  const now = 1_000_000;
  expect(() => assertAuthLifetime(now + 120_000 + OAUTH_REFRESH_WINDOW_MS, 120_000, now)).toThrow(
    "expires",
  );
  expect(() =>
    assertAuthLifetime(now + 120_001 + OAUTH_REFRESH_WINDOW_MS, 120_000, now),
  ).not.toThrow();
  expect(() => assertAuthLifetime(undefined, 120_000, now)).toThrow("expires");
});

test("Pi snapshots retain OAuth classification but never grant refresh capability", async () => {
  const { snapshot, state } = await fixture();
  const expires = Date.now() + 60 * 60 * 1000;
  const original = JSON.stringify({
    anthropic: { type: "oauth", access, refresh, expires },
    other: { type: "api_key", key: "UNSELECTED_ACCOUNT" },
  });
  await writeFile(path.join(snapshot, "auth.json"), original);
  const auth = await stagePiAuthentication(state, "anthropic", snapshot, 120_000, true);
  const child: unknown = JSON.parse(await readFile(path.join(state, "agent/auth.json"), "utf8"));
  expect(child).toEqual({ anthropic: { type: "oauth", access, refresh: "", expires } });
  expect(await readFile(path.join(snapshot, "auth.json"), "utf8")).toBe(original);
  expect(JSON.stringify(auth.policy)).not.toContain(access);
  expect(auth.redact(`output ${access}`)).toBe("output [REDACTED_AUTH_TOKEN]");
  expect(auth.containsSecret(`output ${access}`)).toBe(true);
});

test("Claude receives only the access-token environment and no refresh-capable file", async () => {
  const { snapshot, state } = await fixture();
  const original = JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + 3_600_000,
    },
  });
  await writeFile(path.join(snapshot, ".credentials.json"), original);
  const auth = await stageClaudeAuthentication(state, "claude-sdk", snapshot, 120_000);
  expect(auth.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(access);
  expect(JSON.stringify(auth.environment)).not.toContain(refresh);
  await expect(readFile(path.join(state, "home/.claude/.credentials.json"))).rejects.toThrow(
    "ENOENT",
  );
  expect(await readFile(path.join(snapshot, ".credentials.json"), "utf8")).toBe(original);
});

test("malformed and expired snapshots fail without exposing parser excerpts or secrets", async () => {
  const { snapshot, state } = await fixture();
  await writeFile(path.join(snapshot, "auth.json"), `{"anthropic": ${access}`);
  await expect(stagePiAuthentication(state, "anthropic", snapshot, 120_000)).rejects.toThrow(
    "unavailable or malformed",
  );
  await writeFile(
    path.join(snapshot, "auth.json"),
    JSON.stringify({ anthropic: { type: "oauth", access, refresh, expires: Date.now() - 1 } }),
  );
  await expect(stagePiAuthentication(state, "anthropic", snapshot, 120_000)).rejects.toThrow(
    "expires",
  );
  await expect(readFile(path.join(state, "agent/auth.json"))).rejects.toThrow("ENOENT");
});

test("the SDK auth resolver cannot call the original refresh transport", async () => {
  let credential: Credential = { type: "oauth", access, refresh, expires: 1 };
  let refreshCalls = 0;
  const store: CredentialStore = {
    read: async () => credential,
    list: async () => [{ providerId: "fixture", type: "oauth" }],
    modify: async (_id, fn) => {
      credential = (await fn(credential)) ?? credential;
      return credential;
    },
    delete: async () => {},
  };
  const provider: Provider = {
    id: "fixture",
    name: "Fixture",
    getModels: () => [],
    stream: () => {
      throw new Error("No inference is allowed in this auth test");
    },
    streamSimple: () => {
      throw new Error("No inference is allowed in this auth test");
    },
    auth: {
      oauth: {
        name: "Fixture OAuth",
        login: async () => ({ type: "oauth", access, refresh, expires: 1 }),
        refresh: async () => {
          refreshCalls++;
          return { type: "oauth", access, refresh, expires: 1 };
        },
        toAuth: async (value) => ({ apiKey: value.access }),
      },
    },
  };
  const originalRefresh = provider.auth.oauth?.refresh;
  const models = createModels({ credentials: store });
  models.setProvider(withoutOAuthRefresh(provider));
  await expect(models.getAuth("fixture")).rejects.toThrow("OAuth refresh failed");
  expect(refreshCalls).toBe(0);
  expect(provider.auth.oauth?.refresh).toBe(originalRefresh);
});

test.each([false, true])(
  "delegated auth guards its actual credential owner, refresh=%s",
  (refreshAllowed) => {
    const requested: string[] = [];
    let provider: Provider = {
      id: "anthropic",
      name: "Synthetic credential owner",
      getModels: () => [],
      stream: () => {
        throw new Error("No inference");
      },
      streamSimple: () => {
        throw new Error("No inference");
      },
      auth: {
        oauth: {
          name: "Synthetic OAuth",
          login: async () => ({ type: "oauth", access, refresh, expires: 1 }),
          refresh: async () => {
            throw new Error("No refresh transport in this unit test");
          },
          toAuth: async (value) => ({ apiKey: value.access }),
        },
      },
    };
    const context = {
      model: { provider: "claude-bridge" },
      modelRegistry: {
        getProvider: (id: string) => {
          requested.push(id);
          return provider;
        },
        registerProvider: (next: Provider) => {
          provider = next;
        },
      },
    };
    const policy = {
      provider: "anthropic",
      modelProvider: "claude-bridge",
      expiresAt: null,
      refreshAllowed,
    };
    applyAuthenticationPolicy(context, policy, "/unused-synthetic-audit");
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((id) => id === "anthropic")).toBe(true);
    expect(provider.id).toBe("anthropic");
    expect(() =>
      applyAuthenticationPolicy(
        context,
        { ...policy, modelProvider: "other-model-provider" },
        "/unused-synthetic-audit",
      ),
    ).toThrow("Selected provider differs");
  },
);
