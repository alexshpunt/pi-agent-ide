import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Waits for the real persisted tip instead of assuming startup blocks on inspection. */
export async function waitForTip(context: ExtensionContext): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (
    !context.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-agent-ide-startup-tip")
  ) {
    if (Date.now() >= deadline) throw new Error("The expected startup tip was not published");
    await delay(10);
  }
}
