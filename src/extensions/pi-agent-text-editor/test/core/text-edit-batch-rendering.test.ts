import { expect, test, vi } from "vitest";

import { registerToolBatch, type ToolBatchDefinition } from "#src/core/text-edit-batch-coordinator.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EventHandler = (event: { readonly message: unknown; }) => unknown;

test("publishes inherited arguments while the tool call is streaming", () =>
{
    const handlers = new Map<string, EventHandler>();
    const pi = {
        on(event: string, handler: EventHandler): void
        {
            handlers.set(event, handler);
        },
    } as unknown as ExtensionAPI;
    const onRenderArguments = vi.fn();
    const definition: ToolBatchDefinition<string> = {
        sourceTools: ["replace"],
        syntheticTool: "batch",
        resolveCall(call, inherited)
        {
            const explicit = call.arguments.path;
            const source = typeof explicit === "string" ? explicit : inherited;

            if (source === undefined)
            {
                return;
            }

            return {
                call,
                state: source,
                ...(typeof explicit === "string" ? {} : { renderArgumentPatch: { path: source } }),
            };
        },
        buildArguments: () => ({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: undefined }),
        onRenderArguments,
    };
    registerToolBatch(pi, definition);

    handlers.get("message_update")?.({
        message: {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "replace-first",
                    name: "replace",
                    arguments: { path: "fixture.ts", start: "first", text: "one" },
                },
                {
                    type: "toolCall",
                    id: "replace-second",
                    name: "replace",
                    arguments: { start: "second", text: "partial" },
                },
            ],
        },
    });

    expect(onRenderArguments).toHaveBeenCalledWith("replace-second", { path: "fixture.ts" });
});
