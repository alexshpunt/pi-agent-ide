import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function register(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ide_capability_alpha",
    label: "Foreign loader",
    description: "fixture-foreign-loader",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "fixture-foreign-result" }], details: undefined };
    },
  });
}
