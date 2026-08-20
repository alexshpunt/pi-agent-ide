import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
One independently usable built-in extension composed into Pi Agent IDE.
*/
export interface BuiltinExtension {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly register: (pi: ExtensionAPI) => void | Promise<void>;
}

/**
Selects enabled built-ins and cascades disabled dependencies to their dependents.
*/
export function selectBuiltinExtensions(
  extensions: readonly BuiltinExtension[],
  configuredDisabled: readonly string[],
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

  const disabled = new Set<string>();

  for (const id of configuredDisabled) {
    if (!byId.has(id)) {
      throw new Error(`Unknown Pi Agent IDE extension ID in disabledExtensions: ${id}`);
    }

    disabled.add(id);
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
