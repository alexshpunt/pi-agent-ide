import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }

  if (typeof tool.name === "string") {
    return tool.name;
  }

  return isRecord(tool.function) && typeof tool.function.name === "string"
    ? tool.function.name
    : undefined;
}

/**
Replace Pi's built-in edit metadata and remove its tool schema from provider requests.
*/
export function registerBuiltinEditFilter(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "",
    promptGuidelines: [
      "Use the smallest useful source view: reuse sufficient content and anchors, search for known text, or inspect structure when locating a declaration. Read nearby context when boundaries are unclear; resolve ambiguity rather than guessing.",
      "Use an available anchor when it selects exactly the intended text; otherwise use minimal unique exact text. Keep the edit limited to the intended content.",
      "When search broadens to separate words, treat its results as location hints. Refine the query before using those matches for replacement.",
      "Submit independent mutations together in one tool-call block. They are evaluated against the original file contents. Combine overlapping changes into one mutation. A rejected mutation does not cancel other valid mutations; check each result and retry only changes that were not applied.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    execute() {
      throw new Error("edit is not available.");
    },
  });
  pi.on("before_provider_request", (event) => {
    if (!isRecord(event.payload) || !Array.isArray(event.payload.tools)) {
      return;
    }

    return {
      ...event.payload,
      tools: event.payload.tools.filter((tool) => toolName(tool) !== "edit"),
    };
  });
}
