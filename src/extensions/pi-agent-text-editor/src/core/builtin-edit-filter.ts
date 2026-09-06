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
      "Use replace, insert, delete, copy, and move for precise changes to existing files. Use write only for new files or deliberate complete rewrites.",
      "When changing multiple independent locations, place the mutation tool calls in one tool-call block. They are evaluated against the original file contents. Invalid mutations are rejected while valid mutations can still apply; the block is not all-or-nothing.",
      [
        "When using plain text in `start`, `end`, `anchor`, `targetStart`, or `targetEnd`:",
        "  - Use text that matches the file exactly and occurs only once.",
        "  - Keep it as small as possible while still unique. Do not pad it with large unchanged regions.",
        "  - Plain text is matched against the original file contents, not after earlier mutations are applied.",
      ].join("\n"),
      "Do not emit overlapping or nested mutations in one tool-call block. Merge nearby changes into one mutation.",

      "A mutation that overlaps an earlier accepted mutation is rejected. Check each call's result before retrying; do not repeat edits that already applied.",
      "You can omit a mutation source to reuse the last resolved resource or the previous source in the same tool-call block. Write requires a path; copy and move default their target to the source.",
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
