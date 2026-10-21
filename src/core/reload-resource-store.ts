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

/**
 * Transfer a retained owner to the newly loaded extension instance.
 * Pi reloads extension modules without a cache, so owners cannot be matched by class identity.
 * The owner is returned only when its class has the same source as `owner`. An owner left by
 * other code (an updated package, another checkout or a local edit) is disposed instead,
 * because the new caller cannot rely on its old contract.
 */
export function takeReloadResource<T extends object>(
  key: string,
  owner: abstract new (...args: never[]) => T,
): T | undefined {
  const resources = store();
  const value = resources.get(key);
  resources.delete(key);
  if (value === undefined) return undefined;
  if (
    typeof value === "object" &&
    value !== null &&
    value.constructor.toString() === owner.toString()
  )
    return value as T;
  void Promise.resolve()
    .then(() => (value as { dispose?: () => unknown }).dispose?.())
    // Nothing can recover a foreign owner's failed cleanup; the new owner starts regardless.
    .catch(() => {});
  return undefined;
}

/** Remove a retained owner only when it is the expected instance. */
export function forgetReloadResource(key: string, value: unknown): void {
  const resources = store();
  if (resources.get(key) === value) resources.delete(key);
}
