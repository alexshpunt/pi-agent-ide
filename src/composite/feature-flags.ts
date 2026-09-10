import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Registration metadata drives both Pi flags and the Features settings tab. */
export interface FeatureFlag {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly default: boolean;
  readonly group?: "ui";
  readonly labels?: { readonly on: string; readonly off: string };
}

/** Register a boolean feature once; expose the same definitions to settings. */
export function createFeatureFlags(
  pi: Pick<ExtensionAPI, "registerFlag">,
  saved: Readonly<Record<string, boolean>>,
) {
  const definitions: FeatureFlag[] = [];
  return {
    definitions,
    register(flag: FeatureFlag): void {
      if (definitions.some((item) => item.id === flag.id))
        throw new Error(`Duplicate feature flag: ${flag.id}`);
      definitions.push(flag);
      pi.registerFlag(flag.id, {
        type: "boolean",
        description: flag.description,
        default: saved[flag.id] ?? flag.default,
      });
    },
  };
}
