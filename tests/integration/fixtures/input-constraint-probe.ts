import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface ObservedCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Observe host-validated inputs without replacing Search or its parameter schema. */
export default function registerInputConstraintProbe(pi: ExtensionAPI): void {
  const observed: ObservedCall[] = [];
  pi.on("tool_call", (event) => {
    if (event.toolName !== "search" && event.toolName !== "input_constraint_control") return;
    observed.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: structuredClone(event.input),
    });
  });
  pi.on("session_start", () => {
    const search = pi.getAllTools().find((tool) => tool.name === "search");
    if (search === undefined) throw new Error("The IDE Search tool was not registered");
    pi.registerTool({
      name: "input_constraint_control",
      label: "Input constraint control",
      description: "Return host-validated arguments using the registered Search schema.",
      // No IDE Search backend or wrapper executes for this control.
      parameters: search.parameters,
      async execute(_id, input) {
        return {
          content: [{ type: "text", text: JSON.stringify(input) }],
          details: undefined,
        };
      },
    });
    pi.registerTool({
      name: "input_constraint_snapshot",
      label: "Input constraint snapshot",
      description: "Inspect the registered Search schema and inputs seen after host validation.",
      exposure: "model-only",
      parameters: Type.Object({}),
      async execute() {
        const state = {
          hostEntry: process.argv[1],
          parameters: pi.getAllTools().find((tool) => tool.name === "search")?.parameters,
          observed,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(state) }],
          details: undefined,
        };
      },
    });
  });
}
