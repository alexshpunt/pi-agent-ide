import type { TSchema } from "typebox";

export function appendSchemaFieldOrder(description: string, schema: TSchema): string
{
    const properties = (schema as { readonly properties?: unknown; }).properties;

    if (properties === null || typeof properties !== "object" || Array.isArray(properties))
    {
        return description;
    }

    const fields = Object.keys(properties);
    return fields.length === 0
        ? description
        : `${description}\nArgument order: ${fields.map((field) => `\`${field}\``).join(", ")}.`;
}
