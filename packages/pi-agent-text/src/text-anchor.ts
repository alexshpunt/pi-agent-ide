import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const textAnchorBrand = Symbol.for("pi-agent-text/TextAnchor");

/** A text value resolved by a registered anchor resolver. */
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
    if (value.length === 0) {
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

/** Immutable source snapshot available to an anchor resolver. */
export interface TextAnchorResolverContext {
  readonly source: string;
  readonly content: string;
  readonly lines: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/** Legacy line window used by anchor inspection. */
export interface TextAnchorRecoveryRange {
  readonly offset: number;
  readonly limit: number;
}

/** Why an anchor could not resolve safely. */
export interface TextAnchorRejection {
  readonly code: "invalid" | "stale" | "missing" | "ambiguous";
  readonly reason: string;
  readonly contextRange?: TextAnchorRecoveryRange;
}

/** A position in the current text snapshot. Columns are zero-based. */
export interface TextAnchorRecoveryPosition {
  readonly lineNumber: number;
  readonly column: number;
}

/** A candidate character span in the current text snapshot. */
export interface TextAnchorRecoveryCandidateRange {
  readonly start: TextAnchorRecoveryPosition;
  readonly end: TextAnchorRecoveryPosition;
}

/** A safe candidate returned after an anchor rejection. */
export interface TextAnchorRecoveryCandidate {
  readonly rank: number;
  readonly range: TextAnchorRecoveryCandidateRange;
}

/** Context passed back to the resolver that rejected an anchor. */
export interface TextAnchorResolverRecoveryContext extends TextAnchorResolverContext {
  readonly rejection: TextAnchorRejection;
}

/** Result of an optional, non-mutating anchor recovery attempt. */
export type TextAnchorRecoveryOutcome =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "candidates";
      readonly candidates: readonly TextAnchorRecoveryCandidate[];
      readonly total: number;
    }
  | { readonly kind: "timed-out" }
  | { readonly kind: "failed"; readonly error: unknown };

/** Result of resolving an anchor value. */
export type TextAnchorResolutionAttempt =
  | { readonly kind: "not-handled" }
  | { readonly kind: "resolved"; readonly anchor: TextAnchor }
  | { readonly kind: "rejected"; readonly rejection: TextAnchorRejection }
  | { readonly kind: "failed"; readonly error: unknown };

export type TextAnchorDescriptionSource = string | (() => string | undefined);
/** Context passed to an anchor renderer. */
export interface TextAnchorRenderContext {
  readonly source: string;
  readonly anchor: TextAnchor;
}

/** Renderer functions owned by one anchor resolver. */
export interface TextAnchorRenderer {
  /** Returns the raw value for agent-facing output. */
  renderFull(value: string, context: TextAnchorRenderContext): string;
  /** Returns a short, single-line value for user-facing output. */
  renderCompact(value: string, context: TextAnchorRenderContext): string;
}

interface AttachedTextAnchorRenderer {
  readonly renderer: TextAnchorRenderer;
  readonly resolverId: string;
}

const rendererByAnchor = new WeakMap<TextAnchor, AttachedTextAnchorRenderer>();

/** Associates a resolver-owned renderer with a resolved anchor. */
export function attachTextAnchorRenderer(
  anchor: TextAnchor,
  renderer: TextAnchorRenderer,
  resolverId: string,
): void {
  rendererByAnchor.set(anchor, { renderer, resolverId });
}

/** Returns the renderer attached to a resolved anchor. */
export function getTextAnchorRenderer(anchor: TextAnchor): TextAnchorRenderer | undefined {
  return rendererByAnchor.get(anchor)?.renderer;
}

/** Renders a resolved anchor through its resolver-owned renderer. */
export function renderTextAnchor(
  anchor: TextAnchor,
  value: string,
  context: TextAnchorRenderContext,
): TextAnchorRenderer & {
  readonly full: string;
  readonly compact: string;
  readonly resolverId: string;
} {
  const attached = rendererByAnchor.get(anchor);
  if (attached === undefined) {
    throw new Error(`No renderer is attached to text anchor "${value}"`);
  }

  return {
    ...attached.renderer,
    resolverId: attached.resolverId,
    full: attached.renderer.renderFull(value, context),
    compact: attached.renderer.renderCompact(value, context),
  };
}

/** Resolves one anchor syntax and may recover its own rejected values. */
export interface TextAnchorResolver {
  readonly id: string;
  readonly description: TextAnchorDescriptionSource;
  readonly normalize?: (value: string) => string;
  /** Returns the raw value for agent-facing output. */
  readonly renderFull: TextAnchorRenderer["renderFull"];
  /** Returns a short, single-line value for user-facing output. */
  readonly renderCompact: TextAnchorRenderer["renderCompact"];
  tryResolve(
    value: string,
    context: TextAnchorResolverContext,
  ): Promise<TextAnchorResolutionAttempt>;
  readonly recover?: (
    value: string,
    context: TextAnchorResolverRecoveryContext,
  ) => Promise<TextAnchorRecoveryOutcome>;
}

const objectOptions = { additionalProperties: true } as const;
const functionSchema = Type.Function([], Type.Unknown());
const positionSchema = Type.Object(
  {
    lineNumber: Type.Integer({ minimum: 1 }),
    column: Type.Integer({ minimum: 0 }),
  },
  objectOptions,
);
const candidateSchema = Type.Object(
  {
    rank: Type.Integer({ minimum: 1 }),
    range: Type.Object({ start: positionSchema, end: positionSchema }, objectOptions),
  },
  objectOptions,
);
const resolverSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.Union([Type.String(), functionSchema]),
    normalize: Type.Optional(functionSchema),
    renderFull: functionSchema,
    renderCompact: functionSchema,
    tryResolve: functionSchema,
    recover: Type.Optional(functionSchema),
  },
  objectOptions,
);
const rejectionSchema = Type.Object({
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
});
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
      rejection: rejectionSchema,
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
const recoveryOutcomeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("unavailable") }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("candidates"),
      candidates: Type.Array(candidateSchema),
      total: Type.Integer({ minimum: 0 }),
    },
    objectOptions,
  ),
  Type.Object({ kind: Type.Literal("timed-out") }, objectOptions),
  Type.Object({ kind: Type.Literal("failed"), error: Type.Unknown() }, objectOptions),
]);

/** Returns whether a plugin value satisfies the resolver contract. */
export function isTextAnchorResolver(value: unknown): value is TextAnchorResolver {
  return (
    safeCheck(resolverSchema, value) &&
    safeEvaluate(() => (value as TextAnchorResolver).id.trim().length > 0)
  );
}

/** Returns whether a resolver result satisfies the resolution contract. */
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

/** Returns whether a resolver recovery result is safe for core to consume. */
export function isTextAnchorRecoveryOutcome(value: unknown): value is TextAnchorRecoveryOutcome {
  return safeCheck(recoveryOutcomeSchema, value);
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
