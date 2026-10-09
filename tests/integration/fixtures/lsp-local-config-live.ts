import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probeLocalLspConfigCancellation, probeLocalLspDiscoveryCancellation } from "../support/lsp-local-config-probe.js";

/** Run the native local registry check in the loaded Pi runtime without adding tools. */
export default function localConfigProof(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const proof = await probeLocalLspConfigCancellation(
      ctx.cwd,
      fileURLToPath(new URL("./lsp-owner-server.py", import.meta.url)),
    );
    const discovery = await probeLocalLspDiscoveryCancellation(ctx.cwd);
    await writeFile(path.join(ctx.cwd, "local-config-proof.json"), JSON.stringify({ ...proof, discovery }));
  });
}
