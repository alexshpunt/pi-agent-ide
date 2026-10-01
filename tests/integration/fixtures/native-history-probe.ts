import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Checks disk persistence before the provider responds and adds hidden export fixtures. */
export default function nativeHistoryProbe(pi: ExtensionAPI): void {
  let checked = false;
  pi.on("context", async (_event, ctx) => {
    if (checked) return;
    checked = true;
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Session file missing before first provider request");
    const entries = (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: { role: string } });
    if (
      !entries.some((entry) => entry.message?.role === "user") ||
      entries.some((entry) => entry.message?.role === "assistant")
    ) {
      throw new Error("First user message was not persisted before the assistant response");
    }
    await writeFile(
      path.join(ctx.cwd, "first-request-persisted.txt"),
      "user persisted before assistant\n",
    );
  });
  pi.on("session_start", () => {
    pi.sendMessage({
      customType: "ide-export-guide-probe",
      content: "IDE hidden guide export probe",
      display: false,
    });
    pi.sendMessage({
      customType: "ide-export-diagnostic-probe",
      content: "IDE hidden diagnostic export probe",
      display: false,
    });
  });
}
