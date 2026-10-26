import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createStandaloneResourceHost } from "pi-agent-ide/api/standalone";

/** A separate extension API wrapper must share the session's namespace reservation. */
export default async function duplicateProvider(pi: ExtensionAPI): Promise<void> {
  let refused = false;
  try {
    await createStandaloneResourceHost(pi, {
      namespace: { name: "demo", description: "Must not replace the first provider." },
      ownsSource: () => true,
    });
  } catch (error) {
    refused = error instanceof Error && error.message.includes("namespace already registered");
  }
  pi.registerTool({
    name: "duplicate_status",
    label: "Duplicate namespace status",
    description: "Report the second provider's namespace refusal.",
    parameters: Type.Object({}),
    async execute() {
      if (!refused) throw new Error("A second extension replaced the first host's namespace");
      return { content: [{ type: "text", text: "Duplicate namespace refused" }], details: undefined };
    },
  });
}
