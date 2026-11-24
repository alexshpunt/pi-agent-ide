import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRAPPED_APIS = Symbol.for("pi-problem-report.wrapped-extension-apis");

/** One map per process, so copies of this module loaded from different bundles agree. */
function wrappedApis(): WeakMap<ExtensionAPI, ExtensionAPI> {
  const global = globalThis as { [WRAPPED_APIS]?: WeakMap<ExtensionAPI, ExtensionAPI> };
  global[WRAPPED_APIS] ??= new WeakMap();
  return global[WRAPPED_APIS];
}

/**
 * Record that `wrapper` forwards to `api`. A guard that gives each module its own wrapper calls
 * this so that state shared by the modules of one Pi runtime can key on
 * {@link extensionApiIdentity}.
 */
export function recordExtensionApiWrapper(wrapper: ExtensionAPI, api: ExtensionAPI): void {
  wrappedApis().set(wrapper, api);
}

/**
 * The API that `pi` wraps, through every recorded wrapper. Key per-runtime state that separately
 * registered modules share, such as a registry kept in a WeakMap, by this value instead of `pi`.
 */
export function extensionApiIdentity(pi: ExtensionAPI): ExtensionAPI {
  const wrapped = wrappedApis();
  let current = pi;
  for (let next = wrapped.get(current); next !== undefined; next = wrapped.get(current))
    current = next;
  return current;
}
