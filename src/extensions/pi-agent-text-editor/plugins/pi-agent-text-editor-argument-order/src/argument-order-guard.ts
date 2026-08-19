import {
    type InterceptorContext,
    type InterceptResult,
    registerToolCallInterceptor,
    type ToolCallInterceptorHandler,
} from "pi-agent-text-editor/api/tool-call-interceptor";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ArgumentSchema
{
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly additionalProperties?: boolean;
}

export interface ArgumentSchemaRegistration
{
    readonly name: string;
    readonly schema: ArgumentSchema;
}

interface ArgumentOrderViolation
{
    readonly observedOrder: readonly string[];
    readonly expectedOrder: readonly string[];
    readonly unknownKey?: string;
}

function checkArgumentOrder(
    value: Record<string, unknown>,
    schema: ArgumentSchema,
): ArgumentOrderViolation | undefined
{
    const expectedOrder = Object.keys(schema.properties ?? {});
    const observedOrder = Object.keys(value);
    let lastIndex = -1;

    for (const key of observedOrder)
    {
        const index = expectedOrder.indexOf(key);

        if (index === -1)
        {
            if (schema.additionalProperties === false)
            {
                return { observedOrder, expectedOrder, unknownKey: key };
            }

            continue;
        }

        if (index < lastIndex)
        {
            return { observedOrder, expectedOrder };
        }

        lastIndex = index;
    }

    return undefined;
}

function makeBlockResult(toolName: string, violation: ArgumentOrderViolation): InterceptResult
{
    const unknown = violation.unknownKey ? ` Unknown key: "${violation.unknownKey}".` : "";

    return {
        annotation: { kind: "custom", label: "Argument Order", color: "warning" },
        message: {
            customType: "text-editor-argument-order-block",
            content: `[SYSTEM] ${toolName} blocked: argument order violation.${unknown}\n`
                + `Observed order: ${violation.observedOrder.join(", ") || "(none)"}.\n`
                + `Expected schema order: ${violation.expectedOrder.join(", ") || "(none)"}.\n`
                + `Call ${toolName} again with arguments in schema order.`,
            display: false,
            details: violation,
        },
    };
}

export function registerArgumentOrderGuard(
    pi: ExtensionAPI,
): (registration: ArgumentSchemaRegistration) => void
{
    const schemas = new Map<string, ArgumentSchema>();
    const toolNames: string[] = [];
    const handler: ToolCallInterceptorHandler = {
        name: "text-editor-argument-order-guard",
        blockExecution: true,
        toolNames,
        intercept(ctx: InterceptorContext): InterceptResult | undefined
        {
            const schema = schemas.get(ctx.toolCall.name);

            if (!schema)
            {
                return undefined;
            }

            const violation = checkArgumentOrder(ctx.partialArgs ?? ctx.args, schema);
            return violation ? makeBlockResult(ctx.toolCall.name, violation) : undefined;
        },
    };

    registerToolCallInterceptor(pi, handler);
    return (registration) =>
    {
        schemas.set(registration.name, registration.schema);
        toolNames.push(registration.name);
        registerToolCallInterceptor(pi, handler);
    };
}
