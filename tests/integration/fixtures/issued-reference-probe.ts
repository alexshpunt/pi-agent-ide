import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Capture resolved arguments without treating reference metadata as editable file content. */
export default function issuedReferenceProbe(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({
    name: "issued_reference_probe",
    label: "Issued reference probe",
    description: "Capture substituted fixture arguments.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: "Captured" }], details: input };
    },
  }));
}
