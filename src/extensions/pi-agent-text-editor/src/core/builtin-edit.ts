import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Withdraws Pi's built-in edit from declarations, discovery and nested execution. */
export function hideBuiltinEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "",
    exposure: "hidden",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute() {
      throw new Error("Hidden edit must never execute.");
    },
  });
}
