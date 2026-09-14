import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentContent } from "./content.js";
import type { ResourceResolutionAttempt, ResourceResolver } from "./resolver.js";
import type { Resource } from "./resource.js";

const objectOptions = { additionalProperties: true } as const;
const functionSchema = Type.Function([], Type.Unknown());
const nonEmptyStringSchema = Type.String({ minLength: 1 });

const textContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
    textSignature: Type.Optional(Type.String()),
  },
  objectOptions,
);

const imageContentSchema = Type.Object(
  {
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
  },
  objectOptions,
);

const customContentSchema = Type.Object(
  {
    type: Type.Literal("custom"),
    kind: nonEmptyStringSchema,
    data: Type.Unknown(),
  },
  objectOptions,
);

const agentContentSchema = Type.Array(
  Type.Union([textContentSchema, imageContentSchema, customContentSchema]),
  { minItems: 1 },
);

const resourceSchema = Type.Union([
  Type.Object(
    {
      source: nonEmptyStringSchema,
      link: Type.Optional(nonEmptyStringSchema),
      read: functionSchema,
      write: Type.Optional(Type.Never()),
    },
    objectOptions,
  ),
  Type.Object(
    {
      source: nonEmptyStringSchema,
      link: Type.Optional(nonEmptyStringSchema),
      read: Type.Optional(Type.Never()),
      write: functionSchema,
    },
    objectOptions,
  ),
  Type.Object(
    {
      source: nonEmptyStringSchema,
      link: Type.Optional(nonEmptyStringSchema),
      read: functionSchema,
      write: functionSchema,
    },
    objectOptions,
  ),
]);

const resourceResolverSchema = Type.Object(
  {
    id: nonEmptyStringSchema,
    tryResolve: functionSchema,
  },
  objectOptions,
);

const resourceResolutionAttemptSchema = Type.Union([
  Type.Object({ kind: Type.Literal("not-handled") }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("resolved"),
      resource: resourceSchema,
    },
    objectOptions,
  ),
  Type.Object(
    {
      kind: Type.Literal("failed"),
      error: Type.Unknown(),
    },
    objectOptions,
  ),
]);

export function isAgentContent(value: unknown): value is AgentContent {
  if (!safeCheck(agentContentSchema, value)) {
    return false;
  }

  return safeEvaluate(() =>
    (value as readonly Record<PropertyKey, unknown>[]).every(
      (block) =>
        block.type !== "text" ||
        !("textSignature" in block) ||
        typeof block.textSignature === "string",
    ),
  );
}

export function isResource(value: unknown): value is Resource {
  if (!safeCheck(resourceSchema, value)) {
    return false;
  }

  return safeEvaluate(() => {
    const resource = value as Record<PropertyKey, unknown>;
    const isReadIsValid = !("read" in resource) || typeof resource.read === "function";
    const isWriteIsValid = !("write" in resource) || typeof resource.write === "function";
    return isReadIsValid && isWriteIsValid;
  });
}

export function isResourceResolver(value: unknown): value is ResourceResolver {
  return safeCheck(resourceResolverSchema, value);
}

export function isResourceResolutionAttempt(value: unknown): value is ResourceResolutionAttempt {
  if (!safeCheck(resourceResolutionAttemptSchema, value)) {
    return false;
  }

  return safeEvaluate(() => {
    const attempt = value as Record<PropertyKey, unknown>;
    return attempt.kind !== "resolved" || isResource(attempt.resource);
  });
}

function safeCheck(schema: TSchema, value: unknown): boolean {
  return safeEvaluate(() => Value.Check(schema, value));
}

function safeEvaluate(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}
