import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolName(tool: unknown): string | undefined
{
    if (!isRecord(tool))
    {
        return undefined;
    }

    if (typeof tool.name === "string")
    {
        return tool.name;
    }

    return isRecord(tool.function) && typeof tool.function.name === "string"
        ? tool.function.name
        : undefined;
}

/** Replace Pi's built-in edit metadata and remove its tool schema from provider requests. */
export function registerBuiltinEditFilter(pi: ExtensionAPI): void
{
    pi.registerTool({
        name: "edit",
        label: "edit",
        description: "",
        promptGuidelines: [
            "Use write, replace, insert, delete, copy, and move for text edits.",
            "Independent mutations in one tool-call block run as one transaction against the original files.",
            "Use replace for existing text and write only for a complete file.",
            "An omitted mutation source inherits the last resolved resource or previous source in the same batch. Write requires path; copy and move targets default to their source.",
            "Mutation results include diagnostics and hints.",
        ],
        parameters: Type.Object({}, { additionalProperties: false }),
        execute()
        {
            throw new Error("edit is not available.");
        },
    });
    pi.on("before_provider_request", (event) =>
    {
        if (!isRecord(event.payload) || !Array.isArray(event.payload.tools))
        {
            return;
        }

        return {
            ...event.payload,
            tools: event.payload.tools.filter((tool) => toolName(tool) !== "edit"),
        };
    });
}
