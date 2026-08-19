import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";

import {
    getToolCallRecord,
    registerToolCallRecovery,
} from "#pi-agent-text-editor/core/tool-call-interceptor/coordinator.js";
import { registerToolCallInterceptor } from "pi-agent-text-editor/api/tool-call-interceptor";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const Parameters = Type.Object({
    value: Type.Optional(Type.String()),
    block: Type.Optional(Type.Boolean()),
    entries: Type.Optional(Type.Array(Type.Object({ value: Type.String() }))),
});

function block(content: string)
{
    return {
        message: {
            customType: "tool-interceptor-integration-block",
            content,
            display: false,
        },
    };
}

function registerFixtureTool(pi: ExtensionAPI, name: string): void
{
    pi.registerTool({
        name,
        label: name,
        description: "Tool interceptor integration fixture.",
        parameters: Parameters,
        execute: (toolCallId): Promise<AgentToolResult<unknown>> =>
        {
            const blocked = getToolCallRecord(pi, toolCallId)?.guardResult;
            return Promise.resolve(
                blocked ?? {
                    content: [{ type: "text", text: "executed" }],
                    details: null,
                },
            );
        },
    });
}

export default function registerToolInterceptorIntegrationExtension(pi: ExtensionAPI): void
{
    registerFixtureTool(pi, "intercept_partial");
    registerFixtureTool(pi, "intercept_order");
    registerFixtureTool(pi, "intercept_result");
    registerFixtureTool(pi, "intercept_recovery");
    registerFixtureTool(pi, "intercept_abort_cleanup");

    registerToolCallInterceptor(pi, {
        name: "partial-block",
        toolNames: ["intercept_partial"],
        intercept: (context) => context.partialArgs ? block(`partial:${String(context.partialArgs.value)}`) : undefined,
    });

    registerToolCallInterceptor(pi, {
        name: "order-first",
        toolNames: ["intercept_order"],
        intercept: (context) =>
        {
            context.args.trace = ["old-first"];
        },
    });
    registerToolCallInterceptor(pi, {
        name: "order-second",
        toolNames: ["intercept_order"],
        intercept: (context) =>
        {
            const trace = Array.isArray(context.args.trace)
                ? context.args.trace.filter((entry): entry is string => typeof entry === "string")
                : [];
            return block([...trace, "second"].join(","));
        },
    });
    registerToolCallInterceptor(pi, {
        name: "order-third",
        toolNames: ["intercept_order"],
        intercept: () => block("third-must-not-run"),
    });
    registerToolCallInterceptor(pi, {
        name: "order-first",
        toolNames: ["intercept_order"],
        intercept: (context) =>
        {
            context.args.trace = ["replaced-first"];
        },
    });

    registerToolCallInterceptor(pi, {
        name: "result-block",
        toolNames: ["intercept_result"],
        intercept: () => block("substituted-result"),
    });

    let abortObserved = false;
    registerToolCallInterceptor(pi, {
        name: "abort-cleanup",
        toolNames: ["intercept_abort_cleanup"],
        intercept: (context) =>
        {
            if (context.partialArgs?.block === true)
            {
                return block("abort-cleanup-first-block");
            }

            return context.args.value === "verify"
                ? block(abortObserved ? "abort-cleanup-observed" : "abort-cleanup-missing")
                : undefined;
        },
        onAbort: () =>
        {
            abortObserved = true;
        },
    });

    registerToolCallRecovery(pi, {
        toolName: "intercept_recovery",
        extractEntries: (input) =>
            Array.isArray(input.args.entries)
                ? input.args.entries.flatMap((entry, index) =>
                    entry && typeof entry === "object" && !Array.isArray(entry)
                        ? [{ index: index + 1, value: entry as Record<string, unknown>, complete: true }]
                        : []
                )
                : [],
        buildParams: (entries) => ({ values: entries.map((entry) => entry.value.value) }),
        execute: async (params, context) =>
        {
            await writeFile(path.join(context.cwd, "recovered.json"), JSON.stringify(params));
            return { content: [{ type: "text", text: "recovered" }], details: params };
        },
    });
    registerToolCallInterceptor(pi, {
        name: "recovery-block",
        toolNames: ["intercept_recovery"],
        intercept: (context) =>
            context.partialArgs === undefined && Array.isArray(context.args.entries)
                ? block("recovery-blocked")
                : undefined,
    });
}
