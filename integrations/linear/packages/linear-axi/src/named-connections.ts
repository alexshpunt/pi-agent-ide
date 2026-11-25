import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, isUnknownArray } from "./types.ts";
import {
  ManagedConnection,
  MAX_CONNECTION_STORE_BYTES,
  type ManagedConnectionOptions,
  type ConnectionStatus,
  type ConnectionMethod,
  type SavedConnection,
  type CredentialType,
  type ConnectionActor,
} from "./managed-connection.ts";

interface Profile {
  id: string;
  name: string;
  method: ConnectionMethod;
}
interface Pending extends Profile {
  epoch: string;
  stateHash: string;
  expiresAt: number;
}
interface Catalog {
  version: 2;
  epoch: string;
  defaultConnectionId: string | null;
  connections: Profile[];
  pending: Pending[];
  legacyRetired: boolean;
}
const methods = new Set<ConnectionMethod>([
  "mcp-oauth",
  "user-oauth",
  "app-oauth",
  "api-key",
  "oauth-token",
]);
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
function fail(code: string): never {
  throw new Error(code);
}
const hash = (state: string) => createHash("sha256").update(state).digest("hex");
function connectionName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(value)
  )
    fail("LINEAR_AUTH_INPUT_INVALID");
  return value.trim();
}
function isMethod(value: unknown): value is ConnectionMethod {
  const accepted: ReadonlySet<unknown> = methods;
  return accepted.has(value);
}
function profileRow(value: unknown): Profile {
  const row = asRecord(value);
  if (!row || !isId(row.id) || typeof row.name !== "string" || !isMethod(row.method))
    fail("LINEAR_AUTH_STORE_INVALID");
  connectionName(row.name, "");
  return { id: row.id, name: row.name, method: row.method };
}
function decodeCatalog(value: unknown): Catalog {
  const catalog = asRecord(value);
  if (
    catalog?.version !== 2 ||
    typeof catalog.epoch !== "string" ||
    !catalog.epoch ||
    (catalog.defaultConnectionId !== null && !isId(catalog.defaultConnectionId)) ||
    !isUnknownArray(catalog.connections) ||
    !isUnknownArray(catalog.pending) ||
    catalog.connections.length + catalog.pending.length > 1000 ||
    typeof catalog.legacyRetired !== "boolean"
  )
    fail("LINEAR_AUTH_STORE_INVALID");
  const ids = new Set<string>();
  const decode = (value: unknown): Profile => {
    const profile = profileRow(value);
    if (ids.has(profile.id)) fail("LINEAR_AUTH_STORE_INVALID");
    ids.add(profile.id);
    return profile;
  };
  const connections = catalog.connections.map(decode);
  const pending = catalog.pending.map((value) => {
    const row = asRecord(value);
    if (
      !row ||
      typeof row.epoch !== "string" ||
      !row.epoch ||
      typeof row.stateHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.stateHash) ||
      typeof row.expiresAt !== "number" ||
      !Number.isFinite(row.expiresAt)
    )
      fail("LINEAR_AUTH_STORE_INVALID");
    return { ...decode(row), epoch: row.epoch, stateHash: row.stateHash, expiresAt: row.expiresAt };
  });
  if (
    catalog.defaultConnectionId &&
    !connections.some((row) => row.id === catalog.defaultConnectionId)
  )
    fail("LINEAR_AUTH_STORE_INVALID");
  return {
    version: 2,
    epoch: catalog.epoch,
    defaultConnectionId: catalog.defaultConnectionId,
    connections,
    pending,
    legacyRetired: catalog.legacyRetired,
  };
}
const signedOut = (epoch: string): ConnectionStatus => ({
  state: "signed-out",
  epoch,
  capabilities: { mcp: false, native: false, storage: false, refresh: false, revoke: false },
});

/** A private shared catalog around the existing single-grant OAuth engine.
 * Selection is instance/session-local; only an explicit default is shared.
 * Grant files retain the existing bounded, no-symlink, atomic and locked storage contract.
 */
export class NamedConnections extends ManagedConnection {
  readonly catalogPath: string;
  private readonly profileDirectory: string;
  private readonly configuration: ManagedConnectionOptions;
  private selectionId: string | undefined;
  constructor(options: ManagedConnectionOptions) {
    super(options);
    this.configuration = options;
    this.catalogPath = this.path + ".profiles.json";
    this.profileDirectory = this.path + ".connections";
    this.selectionId = options.env.LINEAR_AXI_CONNECTION_ID;
    if (this.selectionId !== undefined && this.selectionId !== "none" && !isId(this.selectionId))
      fail("LINEAR_AUTH_INPUT_INVALID");
  }
  private profilePath(id: string): string {
    if (!isId(id)) fail("LINEAR_AUTH_INPUT_INVALID");
    return join(this.profileDirectory, id + ".json");
  }
  private grant(id: string, pinned = true): ManagedConnection {
    return new ManagedConnection({
      ...this.configuration,
      env: {
        ...this.configuration.env,
        LINEAR_AXI_CONNECTION_FILE: this.profilePath(id),
        LINEAR_AXI_AUTH_EPOCH: pinned ? this.configuration.env.LINEAR_AXI_AUTH_EPOCH : undefined,
      },
    });
  }
  private async saveCatalog(catalog: Catalog): Promise<void> {
    const next = { ...catalog, epoch: randomUUID() };
    if (
      next.connections.length + next.pending.length > 1000 ||
      Buffer.byteLength(JSON.stringify(next) + "\n") > MAX_CONNECTION_STORE_BYTES
    )
      fail("LINEAR_AUTH_STORE_FULL");
    await this.write(next, this.catalogPath);
    catalog.epoch = next.epoch;
  }
  private async existingCatalog(): Promise<Catalog | undefined> {
    const value = await this.readJson(this.catalogPath);
    return value === undefined ? undefined : decodeCatalog(value);
  }
  private async requiredCatalog(existing = false): Promise<Catalog> {
    const catalog = await (existing ? this.existingCatalog() : this.catalog(true));
    if (!catalog) fail("LINEAR_AUTH_CONTEXT_CHANGED");
    return catalog;
  }
  private async catalog(create = false): Promise<Catalog | undefined> {
    const existing = await this.existingCatalog();
    if (existing?.legacyRetired && !existing.pending.some((row) => row.expiresAt <= Date.now()))
      return existing;
    if (!existing && !create && !(await super.isManaged())) return undefined;
    return this.lock(async () => {
      let catalog = await this.existingCatalog();
      if (catalog?.legacyRetired) {
        await this.pruneExpired(catalog);
        return catalog;
      }
      if (!catalog) {
        const legacy = await super.status();
        catalog = {
          version: 2,
          epoch: randomUUID(),
          defaultConnectionId: null,
          connections: [],
          pending: [],
          legacyRetired: false,
        };
        if (legacy.state === "connected" || legacy.state === "expired") {
          const id = randomUUID();
          // Copy only inside the backend; no credential value reaches status or migration receipts.
          const raw = await this.readJson();
          const credential = asRecord(asRecord(raw)?.credential);
          const method: ConnectionMethod =
            legacy.credentialType === "api-key"
              ? "api-key"
              : credential?.mcp
                ? "mcp-oauth"
                : legacy.actor === "app"
                  ? "app-oauth"
                  : legacy.actor === "user"
                    ? "user-oauth"
                    : "oauth-token";
          await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
          await this.write(raw, this.profilePath(id));
          catalog.connections.push({ id, name: "Existing Linear connection", method });
          catalog.defaultConnectionId = id;
        }
        // Persist the migrated grant/catalog before retiring the legacy location. A restart completes retirement.
        await this.saveCatalog(catalog);
      }
      await this.write({ version: 1, epoch: randomUUID(), state: "signed-out" });
      catalog.legacyRetired = true;
      await this.saveCatalog(catalog);
      return catalog;
    });
  }
  /** Called only under the catalog lock; wait for grant writes before removing private pending state. */
  private async pruneExpired(catalog: Catalog): Promise<void> {
    const expired = catalog.pending.filter((row) => row.expiresAt <= Date.now());
    if (!expired.length) return;
    for (const row of expired) await this.grant(row.id, false).logout();
    catalog.pending = catalog.pending.filter((row) => row.expiresAt > Date.now());
    await this.saveCatalog(catalog);
    for (const row of expired) await rm(this.profilePath(row.id), { force: true });
  }
  private resolveProfile(catalog: Catalog): Profile | undefined {
    if (this.selectionId === "none") return undefined;
    const id = this.selectionId ?? catalog.defaultConnectionId;
    if (!id) return undefined;
    const profile = catalog.connections.find((row) => row.id === id);
    if (!profile) fail("LINEAR_AUTH_CONNECTION_REMOVED");
    // Snapshot a CLI default just as Pi snapshots it for a session.
    this.selectionId ??= profile.id;
    return profile;
  }
  private decorate(status: ConnectionStatus, profile: Profile, catalog: Catalog): ConnectionStatus {
    if (status.state === "legacy") fail("LINEAR_AUTH_CONNECTION_REMOVED");
    return {
      ...status,
      connectionId: profile.id,
      name: profile.name,
      method: profile.method,
      defaultConnectionId: catalog.defaultConnectionId,
    };
  }
  override async status(verifyConnection = false): Promise<ConnectionStatus> {
    const catalog = await this.catalog();
    if (!catalog)
      return this.selectionId === undefined
        ? super.status(verifyConnection)
        : signedOut("unselected");
    const profile = this.resolveProfile(catalog);
    if (!profile)
      return { ...signedOut(catalog.epoch), defaultConnectionId: catalog.defaultConnectionId };
    return this.decorate(await this.grant(profile.id).status(verifyConnection), profile, catalog);
  }
  override async epoch(): Promise<ConnectionStatus> {
    return this.status();
  }
  override async isManaged(): Promise<boolean> {
    return this.selectionId !== undefined || (await this.catalog()) !== undefined;
  }
  private async selectedGrant(): Promise<ManagedConnection | undefined> {
    const catalog = await this.catalog();
    if (!catalog) {
      if (this.selectionId !== undefined) fail("LINEAR_AUTH_REQUIRED");
      return undefined;
    }
    const profile = this.resolveProfile(catalog);
    if (!profile) fail("LINEAR_AUTH_REQUIRED");
    const grant = this.grant(profile.id);
    if ((await grant.epoch()).state === "legacy") fail("LINEAR_AUTH_CONNECTION_REMOVED");
    return grant;
  }
  override async authorization(
    forceRefresh = false,
    target: "native" | "storage" = "native",
  ): Promise<string | undefined> {
    const grant = await this.selectedGrant();
    return grant ? grant.authorization(forceRefresh, target) : undefined;
  }
  override async bearerToken(
    forceRefresh = false,
    serverUrl?: string,
  ): Promise<string | undefined> {
    const grant = await this.selectedGrant();
    return grant ? grant.bearerToken(forceRefresh, serverUrl) : undefined;
  }
  override async enableAppRenewal(declaredScopes: string[]): Promise<ConnectionStatus> {
    const grant = await this.selectedGrant();
    if (!grant) return super.enableAppRenewal(declaredScopes);
    await grant.enableAppRenewal(declaredScopes);
    return this.status();
  }
  override async assertEpoch(): Promise<void> {
    const grant = await this.selectedGrant();
    if (grant) await grant.assertEpoch();
    else await super.assertEpoch();
  }
  async list(): Promise<ConnectionStatus> {
    const catalog = await this.catalog();
    if (!catalog) return { ...(await this.status()), defaultConnectionId: null, connections: [] };
    const connections: SavedConnection[] = await Promise.all(
      catalog.connections.map(async (profile) => {
        const status = await this.grant(profile.id, false).status();
        return {
          ...status,
          state: status.state === "legacy" ? "error" : status.state,
          connectionId: profile.id,
          name: profile.name,
          method: profile.method,
        };
      }),
    );
    let selected: ConnectionStatus;
    try {
      selected = await this.status();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "LINEAR_AUTH_CONNECTION_REMOVED")
        throw error;
      selected = signedOut(catalog.epoch);
    }
    return { ...selected, defaultConnectionId: catalog.defaultConnectionId, connections };
  }
  async select(id: string): Promise<ConnectionStatus> {
    if (!isId(id)) fail("LINEAR_AUTH_INPUT_INVALID");
    const catalog = await this.requiredCatalog();
    if (!catalog.connections.some((row) => row.id === id)) fail("LINEAR_AUTH_CONNECTION_REMOVED");
    const previous = this.selectionId;
    this.selectionId = id;
    try {
      return await this.status(true);
    } catch (error) {
      this.selectionId = previous;
      throw error;
    }
  }
  async rename(id: string, name: string): Promise<ConnectionStatus> {
    if (!isId(id)) fail("LINEAR_AUTH_INPUT_INVALID");
    const nextName = connectionName(name, "");
    await this.catalog(true);
    await this.lock(async () => {
      const catalog = await this.requiredCatalog(true);
      const row = catalog.connections.find((profile) => profile.id === id);
      if (!row) fail("LINEAR_AUTH_CONNECTION_REMOVED");
      this.uniqueName(catalog, nextName, id);
      row.name = nextName;
      await this.saveCatalog(catalog);
    });
    return this.list();
  }
  async setDefault(id: string | null): Promise<ConnectionStatus> {
    if (id !== null && !isId(id)) fail("LINEAR_AUTH_INPUT_INVALID");
    await this.catalog(true);
    await this.lock(async () => {
      const catalog = await this.requiredCatalog(true);
      if (id && !catalog.connections.some((profile) => profile.id === id))
        fail("LINEAR_AUTH_CONNECTION_REMOVED");
      catalog.defaultConnectionId = id;
      await this.saveCatalog(catalog);
    });
    return this.list();
  }
  private uniqueName(catalog: Catalog, name: string, except?: string): void {
    if (
      [...catalog.connections, ...catalog.pending].some(
        (row) => row.id !== except && row.name.toLowerCase() === name.toLowerCase(),
      )
    )
      fail("LINEAR_AUTH_NAME_EXISTS");
  }
  private async publish(profile: Profile, pendingEpoch?: string): Promise<ConnectionStatus> {
    return this.lock(async () => {
      const catalog = await this.requiredCatalog(true);
      if (
        pendingEpoch &&
        !catalog.pending.some((row) => row.id === profile.id && row.epoch === pendingEpoch)
      )
        fail("LINEAR_AUTH_CONTEXT_CHANGED");
      this.uniqueName(catalog, profile.name, profile.id);
      const status = await this.grant(profile.id, false).status();
      if (status.state !== "connected" && status.state !== "expired")
        fail("LINEAR_AUTH_CONTEXT_CHANGED");
      catalog.pending = catalog.pending.filter((row) => row.id !== profile.id);
      catalog.connections.push(profile);
      await this.saveCatalog(catalog);
      this.selectionId = profile.id;
      return this.decorate(status, profile, catalog);
    });
  }
  override async importCredential(input: {
    type: CredentialType;
    token: string;
    name?: string;
  }): Promise<ConnectionStatus> {
    if (!["api-key", "oauth"].includes(input.type)) fail("LINEAR_AUTH_INPUT_INVALID");
    const id = randomUUID();
    const profile: Profile = {
      id,
      name: connectionName(
        input.name,
        `${input.type === "api-key" ? "API key" : "OAuth token"} ${id.slice(0, 8)}`,
      ),
      method: input.type === "api-key" ? "api-key" : "oauth-token",
    };
    await this.catalog(true);
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    try {
      await this.grant(id, false).importCredential(input);
      return await this.publish(profile);
    } catch (error) {
      await rm(this.profilePath(id), { force: true });
      throw error;
    }
  }
  override async connectInstalledApp(input: { name?: string } = {}): Promise<ConnectionStatus> {
    const id = randomUUID();
    const profile: Profile = {
      id,
      name: connectionName(input.name, `Installed App ${id.slice(0, 8)}`),
      method: "oauth-token",
    };
    await this.catalog(true);
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    try {
      await this.grant(id, false).connectInstalledApp();
      return await this.publish(profile);
    } catch (error) {
      await rm(this.profilePath(id), { force: true });
      throw error;
    }
  }

  override async beginLogin(input: {
    actor: ConnectionActor;
    scopes?: string[];
    name?: string;
    method?: "mcp" | "oauth";
  }): Promise<{ url: string; epoch: string; redirectUri: string }> {
    const id = randomUUID();
    const name = connectionName(input.name, `OAuth ${id.slice(0, 8)}`);
    await this.catalog(true);
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    try {
      const start = await this.grant(id, false).beginLogin(input);
      const method: ConnectionMethod =
        new URL(start.url).hostname === "mcp.linear.app"
          ? "mcp-oauth"
          : input.actor === "app"
            ? "app-oauth"
            : "user-oauth";
      await this.lock(async () => {
        const catalog = await this.requiredCatalog(true);
        this.uniqueName(catalog, name);
        catalog.pending.push({
          id,
          name,
          method,
          epoch: start.epoch,
          stateHash: hash(new URL(start.url).searchParams.get("state") ?? ""),
          expiresAt: Date.now() + 10 * 60_000,
        });
        await this.saveCatalog(catalog);
      });
      return start;
    } catch (error) {
      await rm(this.profilePath(id), { force: true });
      throw error;
    }
  }
  override async finishLogin(input: { callbackUrl: string }): Promise<ConnectionStatus> {
    let state: string;
    try {
      state = new URL(input.callbackUrl).searchParams.get("state") ?? "";
    } catch {
      fail("LINEAR_AUTH_INPUT_INVALID");
    }
    const catalog = await this.catalog();
    const pending = catalog?.pending.find((row) => row.stateHash === hash(state));
    if (!pending) fail("LINEAR_AUTH_NO_PENDING_LOGIN");
    if (pending.expiresAt <= Date.now()) fail("LINEAR_AUTH_LOGIN_EXPIRED");
    await this.grant(pending.id, false).finishLogin(input);
    return this.publish(
      { id: pending.id, name: pending.name, method: pending.method },
      pending.epoch,
    );
  }
  override async cancelLogin(epoch: string): Promise<void> {
    const catalog = await this.catalog();
    const pending = catalog?.pending.find((row) => row.epoch === epoch);
    if (!pending) return;
    await this.lock(async () => {
      const current = await this.requiredCatalog(true);
      if (!current.pending.some((row) => row.id === pending.id && row.epoch === epoch)) return;
      await this.grant(pending.id, false).logout();
      current.pending = current.pending.filter((row) => row.id !== pending.id);
      await this.saveCatalog(current);
      await rm(this.profilePath(pending.id), { force: true });
    });
  }
  private async forget(id: string): Promise<void> {
    await this.lock(async () => {
      const catalog = await this.requiredCatalog(true);
      if (!catalog.connections.some((row) => row.id === id)) fail("LINEAR_AUTH_CONNECTION_REMOVED");
      // Wait for any grant refresh/exchange lock before removing its secret material.
      const grant = this.grant(id);
      await grant.assertEpoch();
      await grant.logout();
      catalog.connections = catalog.connections.filter((row) => row.id !== id);
      if (catalog.defaultConnectionId === id) catalog.defaultConnectionId = null;
      await this.saveCatalog(catalog);
      await rm(this.profilePath(id), { force: true });
    });
  }
  override async logout(): Promise<ConnectionStatus> {
    const catalog = await this.requiredCatalog();
    const profile = this.resolveProfile(catalog);
    if (profile) await this.forget(profile.id);
    this.selectionId = "none";
    return this.status();
  }
  override async revoke(
    options: { forgetOnRefusal?: boolean; onRetired?: (epoch: string) => void } = {},
  ): Promise<ConnectionStatus> {
    const catalog = await this.catalog();
    const profile = catalog && this.resolveProfile(catalog);
    if (!profile) fail("LINEAR_AUTH_REVOKE_UNSUPPORTED");
    const grant = this.grant(profile.id);
    let retiredEpoch: string | undefined;
    try {
      await grant.revoke({
        ...options,
        onRetired: (epoch) => {
          retiredEpoch = epoch;
          options.onRetired?.(epoch);
        },
      });
    } catch (error) {
      if (retiredEpoch) await this.forgetRetired(profile.id, retiredEpoch);
      throw error;
    }
    if (!retiredEpoch || !(await this.forgetRetired(profile.id, retiredEpoch)))
      fail("LINEAR_AUTH_CONTEXT_CHANGED");
    this.selectionId = "none";
    return this.status();
  }
  private async forgetRetired(id: string, epoch: string): Promise<boolean> {
    return this.lock(async () => {
      const catalog = await this.requiredCatalog(true);
      if (!catalog.connections.some((row) => row.id === id)) return false;
      return this.grant(id, false).withRetired(epoch, async () => {
        catalog.connections = catalog.connections.filter((row) => row.id !== id);
        if (catalog.defaultConnectionId === id) catalog.defaultConnectionId = null;
        await this.saveCatalog(catalog);
        await rm(this.profilePath(id), { force: true });
      });
    });
  }
}
