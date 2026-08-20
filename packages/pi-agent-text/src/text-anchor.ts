import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const textAnchorBrand = Symbol.for("pi-agent-text/TextAnchor");

export abstract class TextAnchor {
  readonly [textAnchorBrand] = true;

  public static is(value: unknown): value is TextAnchor {
    if (typeof value !== "object" || value === null) {
      return false;
    }

    try {
      const candidate = value as Record<PropertyKey, unknown>;
      return (
        candidate[textAnchorBrand] === true &&
        typeof candidate.value === "string" &&
        Number.isSafeInteger(candidate.lineNumber) &&
        (candidate.lineNumber as number) >= 1
      );
    } catch {
      return false;
    }
  }
  protected constructor(
    readonly value: string,
    readonly lineNumber: number,
  ) {
    if (value.trim().length === 0) {
      throw new TypeError("Text anchor value must be non-empty");
    }

    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
      throw new RangeError("Text anchor line number must be a positive safe integer");
    }
  }

  public toString(): string {
    return this.value;
  }
}

export interface TextAnchorResolverContext {
  readonly source: string;
  readonly content: string;
  readonly lines: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface TextAnchorRecoveryRange {
  readonly offset: number;
  readonly limit: number;
}

export interface TextAnchorRejection {
  readonly code: "invalid" | "stale" | "missing" | "ambiguous";
  readonly reason: string;
  readonly contextRange?: TextAnchorRecoveryRange;
}

export type TextAnchorResolutionAttempt =
  | { readonly kind: "not-handled" }
  | { readonly kind: "resolved"; readonly anchor: TextAnchor }
  | { readonly kind: "rejected"; readonly rejection: TextAnchorRejection }
  | { readonly kind: "failed"; readonly error: unknown };

export type TextAnchorDescriptionSource = string | (() => string | undefined);

export interface TextAnchorResolver {
  readonly id: string;
  readonly description: TextAnchorDescriptionSource;
  readonly normalize?: (value: string) => string;
  tryResolve(
    value: string,
    context: TextAnchorResolverContext,
  ): Promise<TextAnchorResolutionAttempt>;
}

const objectOptions = { additionalProperties: true } as const;
const functionSchema = Type.Function([], Type.Unknown());
const resolverSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.Union([Type.String(), functionSchema]),
    normalize: Type.Optional(functionSchema),
    tryResolve: functionSchema,
  },
  objectOptions,
);
const attemptSchema = Type.Union([
  Type.Object({ kind: Type.Literal("not-handled") }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("resolved"),
      anchor: Type.Unknown(),
    },
    objectOptions,
  ),
  Type.Object(
    {
      kind: Type.Literal("rejected"),
      rejection: Type.Object({
        code: Type.Union([
          Type.Literal("invalid"),
          Type.Literal("stale"),
          Type.Literal("missing"),
          Type.Literal("ambiguous"),
        ]),
        reason: Type.String(),
        contextRange: Type.Optional(
          Type.Object({
            offset: Type.Number(),
            limit: Type.Number(),
          }),
        ),
      }),
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

export function isTextAnchorResolver(value: unknown): value is TextAnchorResolver {
  return (
    safeCheck(resolverSchema, value) &&
    safeEvaluate(() => (value as TextAnchorResolver).id.trim().length > 0)
  );
}

export function isTextAnchorResolutionAttempt(
  value: unknown,
): value is TextAnchorResolutionAttempt {
  return (
    safeCheck(attemptSchema, value) &&
    safeEvaluate(() => {
      const attempt = value as TextAnchorResolutionAttempt;
      return attempt.kind !== "resolved" || TextAnchor.is(attempt.anchor);
    })
  );
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
