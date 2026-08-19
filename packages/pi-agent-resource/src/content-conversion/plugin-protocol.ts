import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { isContentConverterRegistration, isContentTarget } from "./validation.js";

import type { ContentConverterRegistration, ContentTarget } from "./content-converter.js";

export const CONTENT_PROTOCOL = "pi-agent-resource/content-conversion";

export const CONTENT_API_VERSION = 2;

export const CONTENT_HOST_READY_EVENT = `${CONTENT_PROTOCOL}/host/ready`;

export const CONTENT_CONVERTER_REGISTER_EVENT = `${CONTENT_PROTOCOL}/converter/register`;

export interface ContentHostReady
{
    readonly protocol: typeof CONTENT_PROTOCOL;
    readonly apiVersion: typeof CONTENT_API_VERSION;
    readonly target: ContentTarget;
}

export interface ContentConverterRegistrationRequest
{
    readonly registration: ContentConverterRegistration;
    accept(result: Promise<void>): void;
}

const objectOptions = { additionalProperties: true } as const;
const functionSchema = Type.Function([], Type.Unknown());
const readySchema = Type.Object({
    protocol: Type.Literal(CONTENT_PROTOCOL),
    apiVersion: Type.Literal(CONTENT_API_VERSION),
    target: Type.Unknown(),
}, objectOptions);
const registrationRequestSchema = Type.Object({
    registration: Type.Unknown(),
    accept: functionSchema,
}, objectOptions);

export function isContentHostReady(value: unknown): value is ContentHostReady
{
    return safeCheck(readySchema, value)
        && safeEvaluate(() => isContentTarget((value as ContentHostReady).target));
}

export function isContentConverterRegistrationRequest(
    value: unknown,
): value is ContentConverterRegistrationRequest
{
    return safeCheck(registrationRequestSchema, value)
        && safeEvaluate(() =>
            isContentConverterRegistration(
                (value as ContentConverterRegistrationRequest).registration,
            )
        );
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
