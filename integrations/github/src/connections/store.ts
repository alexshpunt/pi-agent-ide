import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import {
  assertWindowsPrivateFile,
  assertWindowsPrivatePath,
} from "#github/windows-private-path.ts";
import type {
  GithubConnectionStorage,
  GithubProfile,
  GithubSecret,
  GithubSecretUpdate,
} from "./types.ts";

const maximumBytes = 1024 * 1024;
const forbiddenIds = new Set(["__proto__", "prototype", "constructor"]);
interface Metadata {
  version: 1;
  profiles: GithubProfile[];
  projectDefaults: Partial<Record<string, string>>;
  legacyProjects?: string[];
}
interface Credentials {
  version: 1;
  secrets: Partial<Record<string, GithubSecret>>;
}
interface GlobalDefault {
  version: 1;
  id?: string;
}
interface GlobalPreference {
  version: 1;
  id: string;
  fileIdentity: string;
}
interface Epochs {
  version: 1;
  generations: Partial<Record<string, string>>;
}
interface State {
  metadata: Metadata;
  credentials: Credentials;
  globalDefault: GlobalDefault;
  epochs: Epochs;
}

function fail(code = "GH_CONNECTION_STORE_INVALID"): never {
  throw new Error(code);
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) fail("GH_CONNECTION_CANCELLED");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function emptyIndex<T>(): Partial<Record<string, T>> {
  return Object.create(null) as Partial<Record<string, T>>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(value) && !forbiddenIds.has(value)
  );
}
function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16384 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value)
  );
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function profile(value: unknown): GithubProfile {
  if (
    !object(value) ||
    !identifier(value.id) ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(value.label)
  )
    fail();
  if (
    value.login !== undefined &&
    (typeof value.login !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/u.test(value.login) ||
      value.login.length > 128)
  )
    fail();
  const base = ["id", "label", "login", "kind"];
  const common = {
    id: value.id,
    label: value.label,
    ...(value.login === undefined ? {} : { login: value.login }),
  };
  if (value.kind === "pat") {
    fields(value, base);
    return { ...common, kind: value.kind };
  }
  if (value.kind === "device") {
    fields(value, [...base, "clientId"]);
    if (typeof value.clientId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value.clientId))
      fail();
    return { ...common, kind: value.kind, clientId: value.clientId };
  }
  if (value.kind === "app") {
    fields(value, [...base, "appId", "installationId", "privateKeyPath"]);
    if (
      !positive(value.appId) ||
      !positive(value.installationId) ||
      typeof value.privateKeyPath !== "string" ||
      value.privateKeyPath.length > 4096 ||
      !path.isAbsolute(value.privateKeyPath) ||
      /[\u0000-\u001f\u007f]/u.test(value.privateKeyPath)
    )
      fail();
    return {
      ...common,
      kind: value.kind,
      appId: value.appId,
      installationId: value.installationId,
      privateKeyPath: value.privateKeyPath,
    };
  }
  return fail();
}
function secret(value: unknown): GithubSecret {
  if (!object(value)) fail();
  if (value.kind === "pat") {
    fields(value, ["kind", "token"]);
    if (!token(value.token)) fail();
    return { kind: value.kind, token: value.token };
  }
  if (value.kind === "device") {
    fields(value, ["kind", "accessToken", "expiresAt", "refreshToken", "refreshExpiresAt"]);
    if (
      !token(value.accessToken) ||
      (value.refreshToken !== undefined && !token(value.refreshToken)) ||
      (value.expiresAt !== undefined && !positive(value.expiresAt)) ||
      (value.refreshExpiresAt !== undefined &&
        (!positive(value.refreshExpiresAt) || value.refreshToken === undefined))
    )
      fail();
    return {
      kind: value.kind,
      accessToken: value.accessToken,
      ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken }),
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
      ...(value.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: value.refreshExpiresAt }),
    };
  }
  return fail();
}
function metadata(value: unknown): Metadata {
  if (!object(value)) fail();
  fields(value, ["version", "profiles", "projectDefaults", "legacyProjects"]);
  if (
    value.version !== 1 ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 1000 ||
    !object(value.projectDefaults)
  )
    fail();
  const profiles = value.profiles.map(profile);
  if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) fail();
  const defaults = emptyIndex<string>();
  for (const [project, id] of Object.entries(value.projectDefaults)) {
    if (
      !path.isAbsolute(project) ||
      project !== path.resolve(project) ||
      !identifier(id) ||
      !profiles.some((entry) => entry.id === id)
    )
      fail();
    defaults[project] = id;
  }
  const legacy = value.legacyProjects;
  if (
    legacy !== undefined &&
    (!Array.isArray(legacy) ||
      legacy.length > 10000 ||
      new Set(legacy).size !== legacy.length ||
      legacy.some(
        (project) =>
          typeof project !== "string" ||
          !path.isAbsolute(project) ||
          project !== projectKey(project),
      ))
  )
    fail();
  return {
    version: 1,
    profiles,
    projectDefaults: defaults,
    ...(legacy === undefined ? {} : { legacyProjects: [...(legacy as string[])] }),
  };
}
function globalDefault(value: unknown): GlobalDefault {
  if (!object(value)) fail();
  fields(value, ["version", "id"]);
  if (value.version !== 1 || (value.id !== undefined && !identifier(value.id))) fail();
  return { version: 1, ...(value.id === undefined ? {} : { id: value.id }) };
}
function globalPreference(value: unknown): GlobalPreference {
  if (!object(value)) fail();
  fields(value, ["version", "id", "fileIdentity"]);
  if (
    value.version !== 1 ||
    !identifier(value.id) ||
    typeof value.fileIdentity !== "string" ||
    !/^[0-9:]{1,256}$/u.test(value.fileIdentity)
  )
    fail();
  return { version: 1, id: value.id, fileIdentity: value.fileIdentity };
}
function epochs(value: unknown): Epochs {
  if (!object(value)) fail();
  fields(value, ["version", "generations"]);
  if (
    value.version !== 1 ||
    !object(value.generations) ||
    Object.keys(value.generations).length > 1000
  )
    fail();
  const generations = emptyIndex<string>();
  for (const [id, generation] of Object.entries(value.generations)) {
    if (!identifier(id) || typeof generation !== "string" || !/^[a-f0-9-]{36}$/u.test(generation))
      fail();
    generations[id] = generation;
  }
  return { version: 1, generations };
}
function credentials(value: unknown): Credentials {
  if (!object(value)) fail();
  fields(value, ["version", "secrets"]);
  if (value.version !== 1 || !object(value.secrets) || Object.keys(value.secrets).length > 1000)
    fail();
  const secrets = emptyIndex<GithubSecret>();
  for (const [id, candidate] of Object.entries(value.secrets)) {
    if (!identifier(id)) fail();
    secrets[id] = secret(candidate);
  }
  return { version: 1, secrets };
}
function projectKey(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 16384 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail();
  return path.resolve(value);
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
function sameConnection(left: GithubProfile, right: GithubProfile): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "app" && right.kind === "app")
    return (
      left.appId === right.appId &&
      left.installationId === right.installationId &&
      left.privateKeyPath === right.privateKeyPath
    );
  if (left.kind === "device" && right.kind === "device") return left.clientId === right.clientId;
  return true;
}

/** One local store lock covers metadata, token rotation and removal across processes.
 * Callbacks passed to withSecret must not re-enter this store: they already own its lock.
 */
export class GithubConnectionStore implements GithubConnectionStorage {
  readonly directory: string;
  constructor(directory = path.join(homedir(), ".config", "pi-agent-github")) {
    this.directory = path.resolve(directory);
  }

  async listProfiles(signal?: AbortSignal): Promise<GithubProfile[]> {
    return this.#locked(async (state) => structuredClone(state.metadata.profiles), signal);
  }
  async getProfile(id: string, signal?: AbortSignal): Promise<GithubProfile | undefined> {
    if (!identifier(id)) fail();
    return this.#locked(
      async (state) => structuredClone(state.metadata.profiles.find((entry) => entry.id === id)),
      signal,
    );
  }
  async saveProfile(
    candidate: GithubProfile,
    supplied?: GithubSecret,
    signal?: AbortSignal,
  ): Promise<void> {
    const next = profile(candidate);
    const provided = supplied === undefined ? undefined : secret(supplied);
    await this.#locked(async (state, guard) => {
      const index = state.metadata.profiles.findIndex((entry) => entry.id === next.id);
      const previous = state.metadata.profiles.at(index);
      if (index >= 0 && previous !== undefined && !sameConnection(previous, next))
        fail("GH_CONNECTION_ID_CHANGED");
      if (index < 0 && next.kind !== "app" && provided === undefined)
        fail("GH_CONNECTION_SECRET_REQUIRED");
      const selected = provided ?? state.credentials.secrets[next.id];
      if (
        (next.kind === "app" && selected !== undefined) ||
        (next.kind !== "app" && selected?.kind !== next.kind)
      )
        fail("GH_CONNECTION_SECRET_REQUIRED");
      await this.#bump(state, next.id, guard);
      if (provided !== undefined) {
        state.credentials.secrets[next.id] = provided;
        await this.#write("credentials.json", state.credentials, guard);
      }
      if (index >= 0) state.metadata.profiles[index] = next;
      else state.metadata.profiles.push(next);
      await this.#write("profiles.json", state.metadata, guard);
    }, signal);
  }
  async removeProfile(id: string, signal?: AbortSignal): Promise<void> {
    if (!identifier(id)) fail();
    await this.#locked(async (state, guard) => this.#remove(state, id, guard), signal);
  }
  async snapshotRemoval(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ profile: GithubProfile; epoch: string } | undefined> {
    if (!identifier(id)) fail();
    return this.#locked(async (state, guard) => {
      const selected = state.metadata.profiles.find((entry) => entry.id === id);
      if (!selected) return undefined;
      if (!state.epochs.generations[id]) {
        for (const oldId of Object.keys(state.epochs.generations)) {
          if (!state.metadata.profiles.some((entry) => entry.id === oldId))
            delete state.epochs.generations[oldId];
        }
        state.epochs.generations[id] = randomUUID();
        await this.#write("epochs.json", state.epochs, guard);
      }
      return { profile: structuredClone(selected), epoch: await this.#stamp(state, id) };
    }, signal);
  }
  async removeProfileIfUnchanged(
    id: string,
    epoch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!identifier(id) || typeof epoch !== "string" || epoch.length > 2048) fail();
    return this.#locked(async (state, guard) => {
      if (
        !state.metadata.profiles.some((entry) => entry.id === id) ||
        (await this.#stamp(state, id)) !== epoch
      )
        return false;
      await this.#remove(state, id, guard);
      return true;
    }, signal);
  }
  async #remove(state: State, id: string, guard: () => void): Promise<void> {
    await this.#bump(state, id, guard);
    state.metadata.profiles = state.metadata.profiles.filter((entry) => entry.id !== id);
    if (state.globalDefault.id === id) {
      delete state.globalDefault.id;
      await this.#write("global-default.json", state.globalDefault, guard);
    }
    for (const [project, selected] of Object.entries(state.metadata.projectDefaults)) {
      if (selected !== id) continue;
      state.metadata.legacyProjects ??= [];
      if (!state.metadata.legacyProjects.includes(project))
        state.metadata.legacyProjects.push(project);
      delete state.metadata.projectDefaults[project];
    }
    // First retire every reference. A crash can leave an inaccessible secret, not a live profile.
    await this.#write("profiles.json", state.metadata, guard);
    delete state.credentials.secrets[id];
    await this.#write("credentials.json", state.credentials, guard);
    if (state.epochs.generations[id]) {
      delete state.epochs.generations[id];
      await this.#write("epochs.json", state.epochs, guard);
    }
  }
  async getGlobalDefault(signal?: AbortSignal): Promise<string | undefined> {
    return this.#locked(async (state) => state.globalDefault.id, signal);
  }
  async getGlobalDefaultChoice(
    signal?: AbortSignal,
  ): Promise<{ id: string | undefined; preferred: boolean }> {
    return this.#locked(async (state) => {
      const raw = await this.#read("global-preference.json");
      const preference = raw === undefined ? undefined : globalPreference(raw);
      const id = state.globalDefault.id;
      const preferred =
        id !== undefined &&
        preference?.id === id &&
        preference.fileIdentity === (await this.#globalFileIdentity());
      return { id, preferred };
    }, signal);
  }
  async setGlobalDefaultForNewSessions(id: string, signal?: AbortSignal): Promise<void> {
    if (!identifier(id)) fail();
    await this.#locked(async (state, guard) => {
      if (!state.metadata.profiles.some((entry) => entry.id === id))
        fail("GH_CONNECTION_NOT_FOUND");
      state.globalDefault.id = id;
      await this.#write("global-default.json", state.globalDefault, guard);
      await this.#write(
        "global-preference.json",
        { version: 1, id, fileIdentity: await this.#globalFileIdentity() },
        guard,
      );
    }, signal);
  }
  async setGlobalDefault(id: string | undefined, signal?: AbortSignal): Promise<void> {
    if (id !== undefined && !identifier(id)) fail();
    await this.#locked(async (state, guard) => {
      if (id !== undefined) {
        if (!state.metadata.profiles.some((entry) => entry.id === id))
          fail("GH_CONNECTION_NOT_FOUND");
        state.globalDefault.id = id;
      } else delete state.globalDefault.id;
      await this.#write("global-default.json", state.globalDefault, guard);
    }, signal);
  }
  async getProjectDefault(project: string, signal?: AbortSignal): Promise<string | undefined> {
    const key = projectKey(project);
    return this.#locked(async (state) => state.metadata.projectDefaults[key], signal);
  }
  /** Import trusted legacy settings at most once per project; removal must stay removed. */
  async ensureLegacyDefault(
    project: string,
    load: () => Promise<Extract<GithubProfile, { kind: "app" }> | undefined>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const key = projectKey(project);
    return this.#locked(async (state, guard) => {
      const selected = state.metadata.projectDefaults[key];
      if (selected || state.metadata.legacyProjects?.includes(key)) return selected;
      const candidate = await load();
      guard();
      state.metadata.legacyProjects ??= [];
      state.metadata.legacyProjects.push(key);
      if (candidate) {
        const next = profile(candidate);
        if (next.kind !== "app") fail();
        const existing = state.metadata.profiles.find((entry) => entry.id === next.id);
        if (existing && !sameConnection(existing, next)) fail("GH_CONNECTION_ID_CHANGED");
        if (!existing) state.metadata.profiles.push(next);
        state.metadata.projectDefaults[key] = next.id;
      }
      await this.#write("profiles.json", state.metadata, guard);
      return state.metadata.projectDefaults[key];
    }, signal);
  }
  async setProjectDefault(
    project: string,
    id: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = projectKey(project);
    if (id !== undefined && !identifier(id)) fail();
    await this.#locked(async (state, guard) => {
      if (id !== undefined) {
        if (!state.metadata.profiles.some((entry) => entry.id === id))
          fail("GH_CONNECTION_NOT_FOUND");
        state.metadata.projectDefaults[key] = id;
      } else delete state.metadata.projectDefaults[key];
      state.metadata.legacyProjects ??= [];
      if (!state.metadata.legacyProjects.includes(key)) state.metadata.legacyProjects.push(key);
      await this.#write("profiles.json", state.metadata, guard);
    }, signal);
  }
  async withSecret<T>(
    id: string,
    update: (current: GithubSecret | undefined) => Promise<GithubSecretUpdate<T>>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!identifier(id)) fail();
    return this.#locked(async (state, guard) => {
      const owner = state.metadata.profiles.find((entry) => entry.id === id);
      if (!owner) fail("GH_CONNECTION_NOT_FOUND");
      const previous = JSON.stringify(state.credentials.secrets[id]);
      const result = await update(structuredClone(state.credentials.secrets[id]));
      guard();
      if (!object(result) || !("secret" in result) || !("value" in result)) fail();
      const next = result.secret === undefined ? undefined : secret(result.secret);
      if (next !== undefined && (owner.kind === "app" || next.kind !== owner.kind)) fail();
      if (next === undefined) delete state.credentials.secrets[id];
      else state.credentials.secrets[id] = next;
      if (JSON.stringify(state.credentials.secrets[id]) !== previous) {
        await this.#bump(state, id, guard);
        await this.#write("credentials.json", state.credentials, guard);
      }
      return result.value;
    }, signal);
  }

  async #bump(state: State, id: string, guard: () => void): Promise<void> {
    if (state.epochs.generations[id]) {
      state.epochs.generations[id] = randomUUID();
      await this.#write("epochs.json", state.epochs, guard);
    }
  }
  // File identities also detect changes made by older clients that do not update epochs.
  // All existing writers replace these files atomically under the same store lock.
  async #stamp(state: State, id: string): Promise<string> {
    const identities: string[] = [];
    for (const file of ["profiles.json", "credentials.json"]) {
      try {
        const info = await lstat(path.join(this.directory, file), { bigint: true });
        identities.push(`${info.dev}:${info.ino}:${info.ctimeNs}:${info.size}`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        identities.push("missing");
      }
    }
    return JSON.stringify([state.epochs.generations[id] ?? "legacy", ...identities]);
  }
  /** Older clients rewrite global-default.json without knowing the preference marker. */
  async #globalFileIdentity(): Promise<string> {
    const info = await lstat(path.join(this.directory, "global-default.json"), { bigint: true });
    return `${info.dev}:${info.ino}:${info.ctimeNs}:${info.size}`;
  }
  async #directory(): Promise<void> {
    if (process.platform !== "win32" && typeof process.getuid !== "function")
      fail("GH_CONNECTION_STORE_UNSUPPORTED");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      fail("GH_CONNECTION_STORE_UNSAFE");
    await assertWindowsPrivatePath(this.directory);
  }
  async #safeTarget(file: string): Promise<void> {
    try {
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (process.platform !== "win32" &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      )
        fail("GH_CONNECTION_STORE_UNSAFE");
      await assertWindowsPrivatePath(file);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  async #read(file: string): Promise<unknown> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const source = path.join(this.directory, file);
      await this.#safeTarget(source);
      handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (process.platform !== "win32" &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      )
        fail("GH_CONNECTION_STORE_UNSAFE");
      await assertWindowsPrivateFile(source, info);
      if (info.size > maximumBytes) fail();
      const buffer = Buffer.alloc(maximumBytes + 1);
      let size = 0;
      for (;;) {
        const part = await handle.read(buffer, size, buffer.length - size, null);
        size += part.bytesRead;
        if (size > maximumBytes) fail();
        if (part.bytesRead === 0) break;
      }
      return JSON.parse(buffer.subarray(0, size).toString("utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  async #state(): Promise<State> {
    const rawMetadata = await this.#read("profiles.json");
    const rawCredentials = await this.#read("credentials.json");
    const rawGlobalDefault = await this.#read("global-default.json");
    const rawEpochs = await this.#read("epochs.json");
    const result: State = {
      metadata:
        rawMetadata === undefined
          ? { version: 1, profiles: [], projectDefaults: emptyIndex<string>() }
          : metadata(rawMetadata),
      credentials:
        rawCredentials === undefined
          ? { version: 1, secrets: emptyIndex<GithubSecret>() }
          : credentials(rawCredentials),
      globalDefault:
        rawGlobalDefault === undefined ? { version: 1 } : globalDefault(rawGlobalDefault),
      epochs:
        rawEpochs === undefined
          ? { version: 1, generations: emptyIndex<string>() }
          : epochs(rawEpochs),
    };
    for (const entry of result.metadata.profiles) {
      const stored = result.credentials.secrets[entry.id];
      if (stored !== undefined && (entry.kind === "app" || stored.kind !== entry.kind)) fail();
    }
    return result;
  }
  async #write(
    file: string,
    value: Metadata | Credentials | GlobalDefault | GlobalPreference | Epochs,
    guard: () => void,
  ): Promise<void> {
    guard();
    await this.#directory();
    const checked =
      file === "profiles.json"
        ? metadata(value)
        : file === "global-default.json"
          ? globalDefault(value)
          : file === "global-preference.json"
            ? globalPreference(value)
            : file === "epochs.json"
              ? epochs(value)
              : credentials(value);
    const output = JSON.stringify(checked) + "\n";
    if (Buffer.byteLength(output) > maximumBytes) fail();
    const target = path.join(this.directory, file);
    await this.#safeTarget(target);
    const temporary = path.join(this.directory, `.write-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await assertWindowsPrivateFile(temporary, await handle.stat());
      await handle.writeFile(output, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      guard();
      await this.#safeTarget(target);
      guard();
      await rename(temporary, target);
      if (process.platform !== "win32") {
        const directory = await open(
          this.directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }
  async #locked<T>(
    operation: (state: State, guard: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    const guard = () => {
      check(signal);
      if (compromised) fail("GH_CONNECTION_STORE_LOCK");
    };
    try {
      guard();
      await this.#directory();
      guard();
      const lockPath = path.join(this.directory, ".store.lock");
      const deadline = Date.now() + 30000;
      while (!release) {
        guard();
        try {
          const info = await lstat(lockPath);
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (process.platform !== "win32" &&
              (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0))
          )
            fail("GH_CONNECTION_STORE_UNSAFE");
          await assertWindowsPrivatePath(lockPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        try {
          release = await lockfile.lock(this.directory, {
            realpath: false,
            lockfilePath: lockPath,
            retries: 0,
            stale: 30000,
            update: 10000,
            onCompromised: () => {
              compromised = true;
            },
          });
        } catch (error) {
          if (errorCode(error) !== "ELOCKED") throw error;
          if (Date.now() >= deadline) fail("GH_CONNECTION_STORE_LOCKED");
          await delay(25, undefined, { signal });
        }
      }
      guard();
      const state = await this.#state();
      guard();
      return await operation(state, guard);
    } catch (error) {
      check(signal);
      // Callback and filesystem errors may carry credentials or private paths in the original object.
      if (
        error instanceof Error &&
        error.message.length <= 80 &&
        /^GH_[A-Z_]+$/u.test(error.message)
      )
        fail(error.message);
      return fail("GH_CONNECTION_STORE_FAILED");
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          fail("GH_CONNECTION_STORE_LOCK");
        }
      }
    }
  }
}
