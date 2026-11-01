import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Sent after saving settings with the merged effective flag overrides. */
export const IDE_FEATURE_FLAGS_CHANGED = "pi-agent-ide/feature-flags-changed/v1";

/** Read an immediately applicable flag, keeping explicit command-line values authoritative. */
export function createLiveFeatureFlag(
  pi: Pick<ExtensionAPI, "events" | "on" | "getFlag">,
  id: string,
  defaultValue = false,
  argv: readonly string[] = process.argv,
): () => boolean {
  let value = pi.getFlag(id) === undefined ? defaultValue : pi.getFlag(id) === true;
  const cliOverride = argv.some((arg) => arg === `--${id}` || arg.startsWith(`--${id}=`));
  const unsubscribe = pi.events.on(IDE_FEATURE_FLAGS_CHANGED, (data: unknown) => {
    if (cliOverride || typeof data !== "object" || data === null || !("flags" in data)) return;
    const flags = data.flags;
    if (typeof flags !== "object" || flags === null || Array.isArray(flags)) return;
    const setting = (flags as Record<string, unknown>)[id];
    if (setting === undefined) value = defaultValue;
    else if (typeof setting === "boolean") value = setting;
  });
  pi.on("session_shutdown", unsubscribe);
  return () => (cliOverride ? pi.getFlag(id) === true : value);
}
