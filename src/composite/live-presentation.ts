import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Broadcast after the effective settings have been saved and resolved for the session. */
export const IDE_PRESENTATION_CHANGED = "pi-agent-ide/presentation-changed/v1";

/** Update presentation state synchronously so renderers never perform filesystem I/O. */
export function listenPresentationPreference(
  pi: Pick<ExtensionAPI, "events" | "on">,
  id: string,
  apply: (value: string | undefined) => void,
): void {
  const unsubscribe = pi.events.on(IDE_PRESENTATION_CHANGED, (data: unknown) => {
    if (typeof data !== "object" || data === null || !("preferences" in data)) return;
    const preferences = data.preferences;
    if (typeof preferences !== "object" || preferences === null || Array.isArray(preferences))
      return;
    const value = (preferences as Record<string, unknown>)[id];
    if (value !== undefined && typeof value !== "string") return;
    apply(value);
  });
  pi.on("session_shutdown", unsubscribe);
}
