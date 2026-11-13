import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Activate `codemode` as the `defaultTools: ["+codemode"]` setting does. Pi registers it inactive,
 * and the isolated export run reads no user settings.
 */
export default function activateCodemode(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
  });
}
