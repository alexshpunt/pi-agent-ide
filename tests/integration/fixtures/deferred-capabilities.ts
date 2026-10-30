import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerIdeCapability } from "#src/api/capabilities.js";

export const alpha = "fixture-capability-alpha";
export const beta = "fixture-capability-beta";

export default function register(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "capability_beta", label: "Capability beta", description: "Fixture beta action",
    exposure: "deferred", namespace: { name: "fixture_capabilities", description: "Capability fixtures" },
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: beta }], details: undefined }; },
  });
  registerIdeCapability(pi, {
    version: 1, id: "fixture.alpha", tools: [],
    discovery: { name: "ide_capability_alpha", description: "Fixture alpha resources", namespace: { name: "fixture_capabilities", description: "Capability fixtures" } },
    schemas: { read: { description: alpha, parameters: { path: alpha }, promptGuidelines: [alpha] } },
  });
  registerIdeCapability(pi, {
    version: 1, id: "fixture.beta", tools: ["capability_beta"],
    schemas: { read: { description: beta, parameters: { path: beta }, promptGuidelines: [beta] } },
  });
  registerIdeCapability(pi, {
    version: 1, id: "fixture.debug", tools: ["debug"],
    schemas: { read: { description: "fixture-capability-debug", parameters: { path: "fixture-capability-debug" }, promptGuidelines: ["fixture-capability-debug"] } },
  });
  pi.registerTool({
    name: "capability_snapshot", label: "Capability snapshot", description: "Inspect fixture capability state", exposure: "model-only",
    parameters: Type.Object({}),
    async execute() {
      const read = pi.getAllTools().find((tool) => tool.name === "read");
      return { content: [{ type: "text", text: JSON.stringify(read) }], details: undefined };
    },
  });
}
