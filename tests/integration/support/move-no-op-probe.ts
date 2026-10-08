import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Observe no-write effects inside Pi, before the runner copies its workspace back. */
export default function moveNoOpProbe(pi: ExtensionAPI): void {
  let result: { details: unknown; isError: boolean } | undefined;
  pi.on("tool_result", (event) => {
    if (event.toolName !== "move") return;
    result = { details: event.details, isError: event.isError };
  });
  pi.registerTool({
    name: "fixture_move_result",
    label: "Move result",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Return the latest observed Move status and effect.",
    parameters: Type.Object({}),
    outputSchema: Type.String(),
    async execute() {
      if (!result) throw new Error("Move result was not observed.");
      const value = JSON.stringify(result);
      return { content: [{ type: "text", text: value }], details: {}, structuredContent: value };
    },
  });
  pi.registerTool({
    name: "fixture_move_stat",
    label: "Move file stat",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Read the fixture files' identity, size and write timestamps.",
    parameters: Type.Object({ paths: Type.Array(Type.String()) }),
    outputSchema: Type.String(),
    async execute(_id, parameters, _signal, _onUpdate, context) {
      const snapshots = await Promise.all(
        parameters.paths.map(async (file) => {
          const snapshot = await stat(path.join(context.cwd, file), { bigint: true });
          return `${snapshot.ino}:${snapshot.size}:${snapshot.mtimeNs}:${snapshot.ctimeNs}`;
        }),
      );
      const value = JSON.stringify(snapshots);
      return { content: [{ type: "text", text: value }], details: {}, structuredContent: value };
    },
  });
}
