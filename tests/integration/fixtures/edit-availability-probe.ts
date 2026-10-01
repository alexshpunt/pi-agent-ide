import { appendFileSync } from "node:fs";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getCurrentTools } from "@earendil-works/pi-ai";

/** Observes public tool availability and the definitions received by the real provider. */
export default function registerEditAvailabilityProbe(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({
    name: "edit_availability_probe",
    label: "Edit availability",
    description: "Report edit availability and attempt a nested call.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, context) {
      const nested = await context.executeTool("edit", {});
      return {
        content: [{ type: "text", text: JSON.stringify({
          edit: pi.getAllTools().find((tool) => tool.name === "edit"),
          active: pi.getActiveTools(),
          callable: context.tools.map((tool) => tool.name),
          nested,
        }) }],
        details: undefined,
      };
    },
  }));
  pi.on("message_end", (event, context) => {
    if (event.message.role !== "user" || !context.model) return;
    const model = context.model;
    const provider = context.modelRegistry.getProvider(model.provider);
    const config = context.modelRegistry.getRegisteredProviderConfig(model.provider);
    if (!provider) throw new Error("Missing smoke provider");
    const delegate = provider.streamSimple.bind(provider);
    pi.registerProvider(model.provider, {
      ...config,
      streamSimple(currentModel, request, options) {
        appendFileSync(path.join(context.cwd, "provider-tools.jsonl"), JSON.stringify(getCurrentTools(request.messages).map((tool) => tool.name)) + "\n");
        return delegate(currentModel, request, options);
      },
    });
  });
}
