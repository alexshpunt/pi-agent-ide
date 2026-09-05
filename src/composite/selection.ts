import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
One independently usable built-in extension composed into Pi Agent IDE.
*/
export interface BuiltinExtension {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly register: (pi: ExtensionAPI) => void | Promise<void>;
  /**
  Set to false for built-ins that stay off until `enabled` lists them in extensions.json.
  */
  readonly defaultEnabled?: boolean;
}

/**
Selects enabled built-ins and cascades disabled dependencies to their dependents.
*/
export function selectBuiltinExtensions(
  extensions: readonly BuiltinExtension[],
  configuredDisabled: readonly string[],
  configuredEnabled: readonly string[] = [],
): { readonly enabled: readonly BuiltinExtension[]; readonly disabled: ReadonlySet<string> } {
  const byId = new Map<string, BuiltinExtension>();

  for (const extension of extensions) {
    if (byId.has(extension.id)) {
      throw new Error(`Duplicate Pi Agent IDE extension ID: ${extension.id}`);
    }

    byId.set(extension.id, extension);
  }

  for (const extension of extensions) {
    for (const dependency of extension.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Pi Agent IDE extension ${extension.id} has unknown dependency ${dependency}`,
        );
      }
    }
  }

  const explicitDisabled = new Set<string>();

  for (const id of configuredDisabled) {
    if (!byId.has(id)) {
      throw new Error(`Unknown Pi Agent IDE extension ID in disabled: ${id}`);
    }

    explicitDisabled.add(id);
  }

  for (const id of configuredEnabled) {
    if (!byId.has(id)) {
      throw new Error(`Unknown Pi Agent IDE extension ID in enabled: ${id}`);
    }
  }

  const forcedOn = collectForcedOn(byId, configuredEnabled, explicitDisabled);

  const disabled = new Set<string>();

  for (const extension of extensions) {
    if (
      (extension.defaultEnabled === false && !forcedOn.has(extension.id)) ||
      explicitDisabled.has(extension.id)
    ) {
      disabled.add(extension.id);
    }
  }

  let isChanged = true;

  while (isChanged) {
    isChanged = false;

    for (const extension of extensions) {
      if (disabled.has(extension.id) || extension.dependencies.every((id) => !disabled.has(id))) {
        continue;
      }

      disabled.add(extension.id);
      isChanged = true;
    }
  }

  return {
    enabled: extensions.filter((extension) => !disabled.has(extension.id)),
    disabled,
  };
}

/**
Collects explicitly enabled IDs plus every dependency they need turned on.
Explicitly disabled IDs always stay off.
*/
function collectForcedOn(
  byId: ReadonlyMap<string, BuiltinExtension>,
  configuredEnabled: readonly string[],
  explicitDisabled: ReadonlySet<string>,
): Set<string> {
  const forcedOn = new Set<string>();
  const pending = [...configuredEnabled];

  while (pending.length > 0) {
    const id = pending.pop() as string;

    if (forcedOn.has(id) || explicitDisabled.has(id)) {
      continue;
    }

    forcedOn.add(id);

    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!forcedOn.has(dependency)) {
        pending.push(dependency);
      }
    }
  }

  return forcedOn;
}
