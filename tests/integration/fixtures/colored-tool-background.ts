import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Gives background regression scenarios a real colored surface without changing user settings. */
export default function useColoredToolBackground(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    // The system fallback has no colored panels when the PTY cannot report terminal colors.
    const result = context.ui.setTheme("dark");
    if (!result.success) throw new Error(result.error ?? "Unable to load the background test theme");
  });
}
