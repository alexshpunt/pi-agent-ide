import { Type } from "typebox";

const numericFields = [
  "retryAfterMs",
  "resetAt",
  "requestsLimit",
  "requestsRemaining",
  "complexityLimit",
  "complexityRemaining",
  "endpointLimit",
  "endpointRemaining",
] as const;

export type ResourceRateLimit = Readonly<
  Partial<Record<(typeof numericFields)[number], number>> & { endpoint?: string }
>;
/** Explicit public diagnostics. Arbitrary provider details are never metadata. */
export interface ResourceErrorMetadata {
  readonly rateLimit?: ResourceRateLimit;
}

export const resourceErrorMetadataSchema = Type.Object(
  {
    rateLimit: Type.Optional(
      Type.Object(
        {
          ...Object.fromEntries(
            numericFields.map((field) => [
              field,
              Type.Optional(
                Type.Integer({
                  minimum: 0,
                  maximum: field === "retryAfterMs" ? 86400000 : Number.MAX_SAFE_INTEGER,
                }),
              ),
            ]),
          ),
          endpoint: Type.Optional(
            Type.String({ maxLength: 80, pattern: "^[A-Za-z0-9_:-]{1,80}$" }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Revalidate at each public boundary; copy only data properties and never invoke getters. */
export function resourceErrorMetadata(value: unknown): ResourceErrorMetadata | undefined {
  try {
    const input = own(value, "rateLimit");
    const rateLimit: Partial<Record<(typeof numericFields)[number], number>> & {
      endpoint?: string;
    } = {};
    for (const field of numericFields) {
      const number = own(input, field);
      if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= 0 &&
        (field !== "retryAfterMs" || number <= 86400000)
      )
        rateLimit[field] = number;
    }
    const endpoint = own(input, "endpoint");
    if (typeof endpoint === "string" && /^[A-Za-z0-9_:-]{1,80}$/u.test(endpoint))
      rateLimit.endpoint = endpoint;
    if (Object.keys(rateLimit).length)
      return Object.freeze({ rateLimit: Object.freeze(rateLimit) });
  } catch {
    // Optional metadata cannot replace the owning failure when a foreign object is unreadable.
  }
}

/** Read opt-in metadata without letting a foreign descriptor replace its owning failure. */
export function resourceErrorMetadataOf(value: unknown): ResourceErrorMetadata | undefined {
  try {
    return resourceErrorMetadata(own(value, "metadata"));
  } catch {
    return;
  }
}
