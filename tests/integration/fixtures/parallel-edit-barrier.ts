import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hold the first nested edit until both peers enter the real tool-call pipeline. */
export default function parallelEditBarrier(pi: ExtensionAPI): void {
  let release: () => void = () => {};
  let waiting: Promise<void>;
  const peers = new Set<string>();
  pi.on("session_start", () => {
    peers.clear();
    waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  pi.on("tool_call", async (event) => {
    if (!event.parentToolCallId || event.toolName !== "insert") return;
    const input: Record<string, unknown> = event.input;
    if (typeof input.path !== "string" || path.basename(input.path) !== "insert.txt") return;
    if (input.anchor === "middle" || input.anchor === "last") {
      peers.add(input.anchor);
      if (peers.size === 2) release();
    }
    if (input.anchor !== "first") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waiting,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Parallel peers did not reach the edit barrier")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}
