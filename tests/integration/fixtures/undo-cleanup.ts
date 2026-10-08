import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type ApplyFileState,
  type ApplyFileBackup,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Inject one cleanup refusal after a real restoration of the fixture-owned file. */
export default async function (pi: ExtensionAPI): Promise<void> {
  let receipt: string | undefined;
  pi.on("tool_result", (event) => {
    if (event.toolName === "apply")
      receipt = /APPLY#[0-9A-F]{12}/u.exec(JSON.stringify(event.content))?.[0];
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "undo" || event.input === null || typeof event.input !== "object") return;
    const input = event.input as Record<string, unknown>;
    if (input.transaction !== "APPLY#000000000000") return;
    if (receipt === undefined) throw new Error("Missing Apply receipt");
    input.transaction = receipt;
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "undo-cleanup-fixture",
    setup(api) {
      api.addApplyFileAccessProvider((previous) => {
        const originals = new WeakMap<ApplyFileBackup, ApplyFileState>();
        let restored = false;
        let refused = false;
        return {
          ...previous,
          async capture(source, signal) {
            const state = await previous.capture(source, signal);
            if (!source.endsWith("/cleanup-owned.txt") || state.backup === undefined) return state;
            const backup = state.backup;
            const wrapped = { ...state, backup: {
              sha256: backup.sha256,
              async release() {
                if (restored && !refused) {
                  refused = true;
                  throw new Error("Fixture journal cleanup unavailable");
                }
                await backup.release();
              },
            } };
            originals.set(wrapped.backup, state);
            return wrapped;
          },
          async restore(state, signal) {
            const original = state.backup === undefined ? undefined : originals.get(state.backup);
            await previous.restore(original ?? state, signal);
            if (state.path.endsWith("/cleanup-owned.txt")) restored = true;
          },
        };
      });
    },
  });
}
