import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { isAgentContent } from "../validation.js";

import type {
    ContentConversionAttempt,
    ContentConversionContext,
    ContentConverter,
    ContentConverterRegistration,
    ContentInput,
    ContentTarget,
} from "./content-converter.js";

const objectOptions = { additionalProperties: true } as const;
const functionSchema = Type.Function([], Type.Unknown());
const nonEmptyStringSchema = Type.String({ minLength: 1 });
const targetSchema = Type.Object({
    provider: nonEmptyStringSchema,
    capability: Type.Union([Type.Literal("read"), Type.Literal("write")]),
}, objectOptions);
const inputSchema = Type.Object({
    source: nonEmptyStringSchema,
    bytes: Type.Unknown(),
    mediaType: Type.Optional(Type.String()),
}, objectOptions);
const contextSchema = Type.Object({
    signal: Type.Optional(Type.Unknown()),
}, objectOptions);
const converterSchema = Type.Object({
    id: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    tryConvert: functionSchema,
}, objectOptions);
const attemptSchema = Type.Union([
    Type.Object({ kind: Type.Literal("not-handled") }, objectOptions),
    Type.Object({
        kind: Type.Literal("converted"),
        content: Type.Unknown(),
    }, objectOptions),
    Type.Object({
        kind: Type.Literal("failed"),
        error: Type.Unknown(),
    }, objectOptions),
]);
const registrationSchema = Type.Object({
    target: Type.Unknown(),
    converter: Type.Unknown(),
    priority: Type.Optional(Type.Number()),
}, objectOptions);

export function isContentTarget(value: unknown): value is ContentTarget
{
    return safeCheck(targetSchema, value)
        && safeEvaluate(() => (value as ContentTarget).provider.trim().length > 0);
}

export function isContentInput(value: unknown): value is ContentInput
{
    if (!safeCheck(inputSchema, value))
    {
        return false;
    }

    return safeEvaluate(() =>
    {
        const input = value as Record<PropertyKey, unknown>;
        return input.bytes instanceof Uint8Array
            && (!("mediaType" in input) || typeof input.mediaType === "string");
    });
}

export function isContentConversionContext(value: unknown): value is ContentConversionContext
{
    if (!safeCheck(contextSchema, value))
    {
        return false;
    }

    return safeEvaluate(() =>
    {
        const context = value as Record<PropertyKey, unknown>;
        return !("signal" in context) || context.signal instanceof AbortSignal;
    });
}

export function isContentConverter(value: unknown): value is ContentConverter
{
    if (!safeCheck(converterSchema, value))
    {
        return false;
    }

    return safeEvaluate(() =>
    {
        const converter = value as ContentConverter;
        return converter.id.trim().length > 0
            && converter.description.trim().length > 0
            && !/[\r\n]/u.test(converter.description);
    });
}

export function isContentConversionAttempt(value: unknown): value is ContentConversionAttempt
{
    if (!safeCheck(attemptSchema, value))
    {
        return false;
    }

    return safeEvaluate(() =>
    {
        const attempt = value as Record<PropertyKey, unknown>;
        return attempt.kind !== "converted" || isAgentContent(attempt.content);
    });
}

export function isContentConverterRegistration(value: unknown): value is ContentConverterRegistration
{
    if (!safeCheck(registrationSchema, value))
    {
        return false;
    }

    return safeEvaluate(() =>
    {
        const registration = value as Record<PropertyKey, unknown>;
        return isContentTarget(registration.target)
            && isContentConverter(registration.converter)
            && (!("priority" in registration)
                || (typeof registration.priority === "number" && Number.isFinite(registration.priority)));
    });
}

function safeCheck(schema: TSchema, value: unknown): boolean
{
    return safeEvaluate(() => Value.Check(schema, value));
}

function safeEvaluate(check: () => boolean): boolean
{
    try
    {
        return check();
    }
    catch
    {
        return false;
    }
}
