import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Retain the real accepted handle across failed scripts, whose Codemode stores are discarded. */
export default function mutationResultProbe(pi: ExtensionAPI): void {
  let target: string | undefined;
  pi.on("tool_result", (event) => {
    if (event.toolName !== "replace" || !event.parentToolCallId) return;
    const result = event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (result.includes("not yet applied")) target = result;
  });
  pi.registerTool({
    name: "fixture_result",
    label: "Fixture result",
    exposure: "codemode",
    namespace: { name: "fixture", description: "Integration fixtures." },
    description: "Return the real handle observed on the last accepted mutation.",
    parameters: Type.Object({}),
    outputSchema: Type.String(),
    async execute() {
      if (!target) throw Error("No accepted target was observed");
      return {
        content: [{ type: "text", text: target }],
        details: {},
        structuredContent: target,
      };
    },
  });
}
