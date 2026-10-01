import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Inspect actual native registry state and exercise nested execution boundaries. */
export default function registerIdeExposureProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ide_exposure_probe",
    label: "IDE exposure probe",
    description: "Inspect the native IDE tool registry or call a nested tool.",
    exposure: "model-only",
    parameters: Type.Object({
      target: Type.Optional(Type.String()),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      deactivate: Type.Optional(Type.String()),
    }),
    async execute(_id, input, _signal, _update, context) {
      if (input.deactivate !== undefined)
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== input.deactivate));
      const nested = input.target === undefined ? undefined :
        await context.executeTool(input.target, input.args ?? {});
      const snapshot = {
        tools: pi.getAllTools().map(({ name, exposure, namespace, annotations }) => ({ name, exposure, namespace, annotations })),
        active: pi.getActiveTools(),
        callable: context.tools.map((tool) => tool.name),
        nested,
      };
      return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
    },
  });
  pi.registerTool({
    name: "stage_note",
    label: "Stage note",
    description: "Stage an unrelated note using a third-party tool.",
    exposure: "deferred",
    namespace: { name: "third_party", description: "Unrelated staging tools." },
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "third-party-stage-marker" }], details: undefined };
    },
  });
}
