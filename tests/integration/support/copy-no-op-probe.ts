import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Observe writes inside Pi, before the test runner copies its workspace back. */
export default function copyNoOpProbe(pi: ExtensionAPI): void {
  const results = new Map<string, string>();
  pi.on("tool_result", (event) => {
    if (event.toolName !== "copy") return;
    results.set(
      event.toolCallId,
      event.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  });
  pi.registerTool({
    name: "fixture_copy_result",
    label: "Copy result",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Return an unchanged real standalone Copy result by call id.",
    parameters: Type.Object({ id: Type.String() }),
    outputSchema: Type.String(),
    async execute(_id, parameters) {
      const value = results.get(parameters.id);
      if (value === undefined) throw new Error("Copy result was not observed.");
      return { content: [{ type: "text", text: value }], details: {}, structuredContent: value };
    },
  });
  pi.registerTool({
    name: "fixture_copy_stat",
    label: "Copy file stat",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Read the unchanged-copy fixture's filesystem timestamps.",
    parameters: Type.Object({}),
    outputSchema: Type.String(),
    async execute(_id, _parameters, _signal, _onUpdate, context) {
      const snapshot = await stat(path.join(context.cwd, "format.txt"), { bigint: true });
      const value = `${snapshot.ino}:${snapshot.size}:${snapshot.mtimeNs}:${snapshot.ctimeNs}`;
      return {
        content: [{ type: "text", text: value }],
        details: {},
        structuredContent: value,
      };
    },
  });
}
