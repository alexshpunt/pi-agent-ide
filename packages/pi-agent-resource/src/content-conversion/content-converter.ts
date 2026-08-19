import type { AgentContent } from "../content.js";

export type ContentCapability = "read" | "write";

export interface ContentTarget
{
    readonly provider: string;
    readonly capability: ContentCapability;
}

export interface ContentInput
{
    readonly source: string;
    readonly bytes: Uint8Array;
    readonly mediaType?: string;
}

export interface ContentConversionContext
{
    readonly signal?: AbortSignal;
}

export type ContentConversionAttempt =
    | { readonly kind: "not-handled"; }
    | { readonly kind: "converted"; readonly content: AgentContent; }
    | { readonly kind: "failed"; readonly error: unknown; };

export interface ContentDescription
{
    readonly id: string;
    readonly description: string;
}

export interface ContentConverter
{
    readonly id: string;
    readonly description: string;
    tryConvert(
        input: ContentInput,
        context: ContentConversionContext,
    ): Promise<ContentConversionAttempt>;
}

export interface ContentConverterRegistration
{
    readonly target: ContentTarget;
    readonly converter: ContentConverter;
    readonly priority?: number;
}
