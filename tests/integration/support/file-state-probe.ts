import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Read file metadata inside the real Pi workspace, before runner synchronization. */
export default function fileStateProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fixture_file_state",
    label: "Fixture file state",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Read a file's modification metadata in the current workspace.",
    parameters: Type.Object({ path: Type.String() }),
    outputSchema: Type.String(),
    async execute(_id, parameters, _signal, _onUpdate, context) {
      const state = await stat(path.resolve(context.cwd, parameters.path));
      const value = JSON.stringify({
        mtimeMs: state.mtimeMs,
        ctimeMs: state.ctimeMs,
        ino: state.ino,
      });
      return {
        content: [{ type: "text", text: value }],
        details: {},
        structuredContent: value,
      };
    },
  });
}
