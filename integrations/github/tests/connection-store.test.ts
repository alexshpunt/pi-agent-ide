import { githubPackageRoot } from "./fixtures/package-root.ts";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lockfile from "proper-lockfile";
import { GithubConnectionStore } from "#github/connections/store.ts";
import { GithubConnections } from "#github/connections/manager.ts";
import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import type { GithubProfile, GithubSecret } from "#github/connections/types.ts";

const run = promisify(execFile);
let temporary: string;
let directory: string;
let store: GithubConnectionStore;
const pat: GithubProfile = { id: "personal", kind: "pat", label: "Personal", login: "example" };
const device: GithubProfile = {
  id: "work",
  kind: "device",
  label: "Work",
  clientId: "Iv1_example",
  login: "example",
};
const patSecret: GithubSecret = { kind: "pat", token: "canary-personal-token" };
const deviceSecret: GithubSecret = {
  kind: "device",
  accessToken: "access-0",
  refreshToken: "rotation-0",
  expiresAt: Date.now() + 3600000,
};

beforeEach(async () => {
  await mkdir(path.join(githubPackageRoot, ".tmp"), { recursive: true });
  temporary = await mkdtemp(path.join(githubPackageRoot, ".tmp/connection-store-"));
  directory = path.join(temporary, "connections");
  store = new GithubConnectionStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { recursive: true, force: true });
});

async function secret(id: string, selected = store): Promise<GithubSecret | undefined> {
  return selected.withSecret(id, async (current) => ({ secret: current, value: current }));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("local GitHub connection storage", () => {
  it("keeps tokens out of profile metadata and protects both files and the directory", async () => {
    await store.saveProfile(pat, patSecret);
    await store.saveProfile(device, deviceSecret);
    expect(await store.listProfiles()).toEqual([pat, device]);
    expect(await secret(pat.id)).toEqual(patSecret);
    const metadata = await readFile(path.join(directory, "profiles.json"), "utf8");
    expect(metadata).not.toContain(patSecret.token);
    expect(metadata).not.toContain("rotation-0");
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    for (const file of ["profiles.json", "credentials.json"])
      expect((await lstat(path.join(directory, file))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(["profiles.json", "credentials.json"]),
    );
  });

  it("preserves a saved secret during metadata updates and removes defaults with a profile", async () => {
    await store.saveProfile(pat, patSecret);
    const project = path.join(temporary, "project");
    // oxlint-disable-next-line repo/no-parent-paths -- pass an unnormalized project key to the store, not to the filesystem
    await store.setProjectDefault(`${project}${path.sep}nested${path.sep}..`, pat.id);
    await store.saveProfile({ ...pat, label: "Renamed" });
    expect((await store.getProfile(pat.id))?.label).toBe("Renamed");
    expect(await secret(pat.id)).toEqual(patSecret);
    expect(await store.getProjectDefault(project)).toBe(pat.id);
    await store.removeProfile(pat.id);
    expect(await store.getProfile(pat.id)).toBeUndefined();
    expect(await store.getProjectDefault(project)).toBeUndefined();
    expect(await readFile(path.join(directory, "credentials.json"), "utf8")).not.toContain(
      patSecret.token,
    );
    await expect(secret(pat.id)).rejects.toBeInstanceOf(Error);
    await expect(store.setProjectDefault(project, "missing")).rejects.toBeInstanceOf(Error);
  });

  it("persists a global default and removes it only with its profile", async () => {
    await store.saveProfile(pat, patSecret);
    await store.saveProfile(device, deviceSecret);
    const before = await readFile(path.join(directory, "profiles.json"), "utf8");
    await store.setGlobalDefault(pat.id);
    expect(await readFile(path.join(directory, "profiles.json"), "utf8")).toBe(before);
    expect((await lstat(path.join(directory, "global-default.json"))).mode & 0o777).toBe(0o600);
    expect(await new GithubConnectionStore(directory).getGlobalDefault()).toBe(pat.id);
    await expect(store.setGlobalDefault("missing")).rejects.toBeInstanceOf(Error);
    await store.removeProfile(device.id);
    expect(await store.getGlobalDefault()).toBe(pat.id);
    await store.removeProfile(pat.id);
    expect(await store.getGlobalDefault()).toBeUndefined();
  });
  it("keeps old project defaults while an explicitly selected global account takes precedence", async () => {
    await store.saveProfile(pat, patSecret);
    await store.saveProfile(device, deviceSecret);
    const project = path.join(temporary, "project");
    await store.setProjectDefault(project, pat.id);
    await store.setGlobalDefault(pat.id);
    expect(await store.getGlobalDefaultChoice()).toEqual({ id: pat.id, preferred: false });
    await store.setGlobalDefaultForNewSessions(device.id);
    const reopened = new GithubConnectionStore(directory);
    expect(await reopened.getGlobalDefaultChoice()).toEqual({ id: device.id, preferred: true });
    expect(await reopened.getProjectDefault(project)).toBe(pat.id);
    expect(JSON.parse(await readFile(path.join(directory, "global-default.json"), "utf8"))).toEqual(
      { version: 1, id: device.id },
    );
    expect((await lstat(path.join(directory, "global-preference.json"))).mode & 0o777).toBe(0o600);
    await reopened.removeProfile(device.id);
    expect(await reopened.getGlobalDefaultChoice()).toEqual({ id: undefined, preferred: false });
    expect(await reopened.getProjectDefault(project)).toBe(pat.id);
  });

  it("keeps a running session pinned while a new session uses the explicitly selected global account", async () => {
    await store.saveProfile(pat, patSecret);
    await store.saveProfile(device, deviceSecret);
    const project = path.join(temporary, "project");
    await store.setProjectDefault(project, pat.id);
    const create = () =>
      new GithubConnections({
        store: new GithubConnectionStore(directory),
        coordinator: isolatedCoordinator(),
        legacyConfig: async () => undefined,
      });
    const existing = create();
    const fresh = create();
    try {
      expect((await existing.capture(project)).profile.id).toBe(pat.id);
      await store.setGlobalDefaultForNewSessions(device.id);
      expect((await existing.capture(project)).profile.id).toBe(pat.id);
      expect((await fresh.capture(project)).profile.id).toBe(device.id);
      expect(await store.getProjectDefault(project)).toBe(pat.id);
    } finally {
      existing.dispose();
      fresh.dispose();
    }
  });
  it("recognizes an older client's global-default rewrite even when the selected ID is unchanged", async () => {
    await store.saveProfile(pat, patSecret);
    await store.setGlobalDefaultForNewSessions(pat.id);
    expect((await store.getGlobalDefaultChoice()).preferred).toBe(true);
    await new GithubConnectionStore(directory).setGlobalDefault(pat.id);
    expect(await store.getGlobalDefaultChoice()).toEqual({ id: pat.id, preferred: false });
  });
  it("serializes independent instances without conflating credentials for the same login", async () => {
    const other = new GithubConnectionStore(directory);
    await Promise.all([store.saveProfile(pat, patSecret), other.saveProfile(device, deviceSecret)]);
    expect((await store.listProfiles()).map((profile) => profile.id).sort()).toEqual([
      "personal",
      "work",
    ]);
    const rotate = (selected: GithubConnectionStore) =>
      selected.withSecret(device.id, async (current) => {
        if (current?.kind !== "device") throw new Error("missing device secret");
        const previous = Number(current.refreshToken?.split("-").at(-1));
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          secret: { ...current, refreshToken: `rotation-${previous + 1}` },
          value: previous,
        };
      });
    expect((await Promise.all([rotate(store), rotate(other)])).sort()).toEqual([0, 1]);
    expect(await secret(pat.id)).toEqual(patSecret);
    expect((await secret(device.id))?.kind).toBe("device");
    expect(await secret(device.id)).toMatchObject({ refreshToken: "rotation-2" });
  });

  it("serializes rotating refresh credentials across real processes", async () => {
    await store.saveProfile(device, deviceSecret);
    const worker = path.join(import.meta.dirname, "fixtures/connection-store-worker.ts");
    const children = await Promise.all(
      [0, 1].map(() => run(process.execPath, [worker, directory, device.id], { timeout: 10000 })),
    );
    expect(children.map((child) => Number(child.stdout)).sort()).toEqual([0, 1]);
    expect(await secret(device.id)).toMatchObject({
      accessToken: "access-2",
      refreshToken: "rotation-2",
    });
  });

  it("does not let a refresh resurrect a profile removed by another store", async () => {
    await store.saveProfile(device, deviceSecret);
    const entered = deferred();
    const finish = deferred();
    const refresh = store.withSecret(device.id, async (current) => {
      entered.resolve();
      await finish.promise;
      return { secret: current, value: undefined };
    });
    await entered.promise;
    const removal = new GithubConnectionStore(directory).removeProfile(device.id);
    finish.resolve();
    await Promise.all([refresh, removal]);
    expect(await store.getProfile(device.id)).toBeUndefined();
    await expect(secret(device.id)).rejects.toBeInstanceOf(Error);
    expect(await readFile(path.join(directory, "credentials.json"), "utf8")).not.toContain(
      "rotation-0",
    );
  });

  it("cancels lock waiters and refuses a cancelled callback's save", async () => {
    await store.saveProfile(device, deviceSecret);
    const entered = deferred();
    const finish = deferred();
    const controller = new AbortController();
    const update = store.withSecret(
      device.id,
      async (current) => {
        entered.resolve();
        await finish.promise;
        if (current?.kind !== "device") throw new Error("missing device secret");
        return { secret: { ...current, refreshToken: "should-not-save" }, value: undefined };
      },
      controller.signal,
    );
    await entered.promise;
    const waitingController = new AbortController();
    const waiter = new GithubConnectionStore(directory).listProfiles(waitingController.signal);
    waitingController.abort();
    await expect(waiter).rejects.toBeInstanceOf(Error);
    controller.abort();
    finish.resolve();
    await expect(update).rejects.toBeInstanceOf(Error);
    expect(await secret(device.id)).toEqual(deviceSecret);
  });

  it("never accepts embedded metadata secrets, unknown fields or mismatched credential kinds", async () => {
    const invalid = [
      { ...pat, token: "canary-embedded-token" },
      { ...pat, label: "bad\u001b[31m" },
      // oxlint-disable-next-line repo/no-parent-paths -- adversarial profile ID stays data; never resolved as a file path
      { ...pat, id: "../escape" },
      { ...pat, id: "__proto__" },
      { ...device, clientId: "bad\nheader" },
      {
        id: "app",
        kind: "app",
        label: "Bot",
        appId: 1,
        installationId: 2,
        privateKeyPath: "relative.pem",
      },
    ];
    for (const value of invalid) {
      const failure = await store
        .saveProfile(value as GithubProfile, patSecret)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("canary-embedded-token");
    }
    await expect(store.saveProfile(pat, deviceSecret)).rejects.toBeInstanceOf(Error);
    await expect(
      store.saveProfile(pat, { kind: "pat", token: "bad\r\nheader" }),
    ).rejects.toBeInstanceOf(Error);
    expect(await store.listProfiles()).toEqual([]);
  });

  it("rejects unsafe files and directories without changing permissions or following links", async () => {
    await store.saveProfile(pat, patSecret);
    const credentials = path.join(directory, "credentials.json");
    await chmod(credentials, 0o644);
    await expect(secret(pat.id)).rejects.toBeInstanceOf(Error);
    expect((await lstat(credentials)).mode & 0o777).toBe(0o644);
    await chmod(credentials, 0o600);
    const contents = await readFile(credentials, "utf8");
    await rm(credentials);
    const outside = path.join(temporary, "outside.json");
    await writeFile(outside, contents, { mode: 0o600 });
    await symlink(outside, credentials);
    await expect(secret(pat.id)).rejects.toBeInstanceOf(Error);
    expect(await readFile(outside, "utf8")).toBe(contents);
    await rm(credentials);
    await link(outside, credentials);
    await expect(secret(pat.id)).rejects.toBeInstanceOf(Error);
    await rm(credentials);
    await writeFile(credentials, contents, { mode: 0o600 });
    await chmod(directory, 0o755);
    await expect(store.listProfiles()).rejects.toBeInstanceOf(Error);
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    await chmod(directory, 0o700);
    const linkedDirectory = path.join(temporary, "linked-store");
    await symlink(directory, linkedDirectory);
    await expect(new GithubConnectionStore(linkedDirectory).listProfiles()).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("rejects a named pipe before opening a blocking read", async () => {
    await store.saveProfile(pat, patSecret);
    const file = path.join(directory, "credentials.json");
    await rm(file);
    await run("mkfifo", [file]);
    // Unblock a regressed reader so a failing assertion cannot strand the test process.
    let neededRescue = false;
    const unblock = setTimeout(() => {
      neededRescue = true;
      void open(file, constants.O_WRONLY | constants.O_NONBLOCK)
        .then((handle) => handle.close())
        .catch(() => {});
    }, 1500);
    try {
      await expect(store.listProfiles()).rejects.toBeInstanceOf(Error);
      expect(neededRescue).toBe(false);
    } finally {
      clearTimeout(unblock);
    }
  });
  it("leaves malformed or oversized saved data unchanged and hides its contents", async () => {
    await store.saveProfile(pat, patSecret);
    const credentials = path.join(directory, "credentials.json");
    for (const data of ['{"canary-invalid-json":', "x".repeat(1048577)]) {
      await writeFile(credentials, data, { mode: 0o600 });
      const failure = await secret(pat.id).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("canary-invalid-json");
      expect(await readFile(credentials, "utf8")).toBe(data);
    }
  });

  it("refuses a save after the library reports a compromised lock", async () => {
    await store.saveProfile(pat, patSecret);
    const before = await readFile(path.join(directory, "credentials.json"), "utf8");
    const original = lockfile.lock.bind(lockfile);
    let compromise: (() => void) | undefined;
    vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
      const release = await original(file, options);
      compromise = () => {
        options?.onCompromised?.(new Error("canary-lock-error"));
      };
      return release;
    });
    await expect(
      store.withSecret(pat.id, async () => {
        compromise?.();
        return { secret: { kind: "pat", token: "should-not-save" }, value: undefined };
      }),
    ).rejects.toThrow("GH_CONNECTION_STORE_LOCK");
    expect(await readFile(path.join(directory, "credentials.json"), "utf8")).toBe(before);
  });
  it("does not commit callback failure or retain partial temporary files", async () => {
    await store.saveProfile(pat, patSecret);
    const before = await readFile(path.join(directory, "credentials.json"), "utf8");
    const failure = await store
      .withSecret(pat.id, async () => {
        throw new Error("canary-personal-token");
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("canary-personal-token");
    const unsafeError = new Error("GH_AUTH_REFRESH_FAILED", {
      cause: new Error("canary-error-cause"),
    });
    unsafeError.stack = "canary-error-stack";
    const forwarded = await store
      .withSecret(pat.id, async () => {
        throw unsafeError;
      })
      .catch((error: unknown) => error);
    if (!(forwarded instanceof Error)) throw new Error("Expected a sanitized failure");
    expect(forwarded.message).toBe("GH_AUTH_REFRESH_FAILED");
    expect(forwarded).not.toHaveProperty("cause");
    expect(forwarded.stack).not.toContain("canary-error-stack");
    expect(await readFile(path.join(directory, "credentials.json"), "utf8")).toBe(before);
    expect((await readdir(directory)).sort()).toEqual(["credentials.json", "profiles.json"]);
    await store.saveProfile({
      id: "app",
      kind: "app",
      label: "Bot",
      appId: 12,
      installationId: 34,
      privateKeyPath: "/private/app.pem",
    });
    expect(await store.getProfile("app")).toMatchObject({ kind: "app" });
  });
});
