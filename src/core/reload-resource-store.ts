const reloadResourceStoreKey = Symbol.for("pi-agent-ide.reload-resource-store");

type ReloadResourceStore = Map<string, unknown>;
type GlobalWithReloadResources = typeof globalThis & {
  [reloadResourceStoreKey]?: ReloadResourceStore;
};

function store(): ReloadResourceStore {
  const sharedGlobal = globalThis as GlobalWithReloadResources;
  const existing = sharedGlobal[reloadResourceStoreKey];
  if (existing !== undefined) return existing;
  const created = new Map<string, unknown>();
  sharedGlobal[reloadResourceStoreKey] = created;
  return created;
}

/** Retain one live resource owner while extension modules reload in this process. */
export function retainReloadResource(key: string, value: unknown): void {
  store().set(key, value);
}

/** Transfer a retained resource owner to the newly loaded extension instance. */
export function takeReloadResource(key: string): unknown {
  const resources = store();
  const value = resources.get(key);
  resources.delete(key);
  return value;
}

/** Remove a retained owner only when it is the expected instance. */
export function forgetReloadResource(key: string, value: unknown): void {
  const resources = store();
  if (resources.get(key) === value) resources.delete(key);
}
