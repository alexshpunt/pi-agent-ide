import { defineTool, type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Reports the host actually running the fixture and supplies a deferred discovery target. */
export default function registerNativeHostProbe(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({
    name: "native_host_probe",
    label: "Native host probe",
    description: "Report the running Pi version and registered tools.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: JSON.stringify({ version: VERSION, tools: pi.getAllTools().map((tool) => tool.name) }) }],
        details: undefined,
      };
    },
  }));
  pi.registerTool(defineTool({
    name: "sdk_deferred_probe",
    label: "SDK deferred probe",
    description: "Return the unique SDK deferred discovery marker.",
    exposure: "deferred",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "sdk-deferred-marker" }], details: undefined };
    },
  }));
}
