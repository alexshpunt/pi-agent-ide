import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise idle native keyboard handling without credentials or provider requests. */
export default function capabilityTerminalIdle(pi: ExtensionAPI): void {
  const marker = (name: string) => path.join("/state", name);
  pi.on("session_start", () => {
    if (process.env.CAPABILITY_FORCE_TIMEOUT === "1") process.on("SIGTERM", () => {});
    process.stdout.write("\nCAPABILITY_NATIVE_IDLE_READY\n");
  });
  pi.on("before_provider_request", () => {
    writeFileSync(marker("unexpected-request"), "blocked");
    throw new Error("This idle terminal test forbids provider requests");
  });
  pi.on("session_shutdown", () => {
    writeFileSync(marker("shutdown"), "closed");
  });
}
