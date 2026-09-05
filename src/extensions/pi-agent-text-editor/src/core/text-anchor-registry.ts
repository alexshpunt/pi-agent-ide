import { requiredValue } from "pi-agent-invariant";
import {
  attachTextAnchorRenderer,
  isTextAnchorRecoveryOutcome,
  isTextAnchorResolutionAttempt,
  type TextAnchor,
  type TextAnchorRecoveryOutcome,
  type TextAnchorRejection,
  type TextAnchorResolver,
  type TextAnchorResolverContext,
  type TextTarget,
} from "pi-agent-text";

import {
  isTextAnchorResourceResolutionAttempt,
  type TextAnchorResolverRegistration,
  type TextAnchorResourceResolver,
  type TextAnchorResourceResolverContext,
  type TextAnchorType,
} from "#src/api/plugin-protocol.js";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";

import type { TextAnchorInspectionOutcome } from "#src/api/anchor-inspection.js";
const resolvedAnchorTypes = new WeakMap<TextAnchor, TextAnchorType>();

/** Returns the registered resolver type that produced an anchor. */
export function resolvedTextAnchorType(anchor: TextAnchor): TextAnchorType | undefined {
  return resolvedAnchorTypes.get(anchor);
}

interface RegisteredTextAnchorResolver {
  readonly resolver: TextAnchorResolver;
  readonly resources?: TextAnchorResourceResolver;
  readonly kind: string;
  readonly type: TextAnchorType;
  readonly priority: number;
  readonly order: number;
  readonly describeInPrompt: boolean;
}

export class TextAnchorResolutionError extends Error {
  public constructor(
    message: string,
    readonly resolverId?: string,
    options?: ErrorOptions,
    readonly rejection?: TextAnchorRejection,
    public recovery?: TextAnchorRecoveryOutcome,
    private readonly recoverAgain?: (
      context: TextAnchorResolverContext,
    ) => Promise<TextAnchorRecoveryOutcome>,
    private readonly originalRecoveryContext?: TextAnchorResolverContext,
  ) {
    super(message, options);
  }

  /** Recomputes recovery against a supplied or original immutable source snapshot. */
  public async refreshRecovery(context?: TextAnchorResolverContext): Promise<void> {
    const recoveryContext = context === undefined ? this.originalRecoveryContext : context;
    if (this.recoverAgain !== undefined && recoveryContext !== undefined) {
      this.recovery = await this.recoverAgain(recoveryContext);
    }
  }
}

export class TextAnchorRegistry {
  readonly #resolvers: RegisteredTextAnchorResolver[] = [];

  public add(registration: TextAnchorResolverRegistration): void {
    if (typeof registration.kind !== "string" || registration.kind.trim().length === 0) {
      throw new TypeError("Text anchor resolver kind must be a non-empty string");
    }

    const resolverId = registration.resolver.id;

    if (this.#resolvers.some(({ resolver }) => resolver.id === resolverId)) {
      throw new Error(`Text anchor resolver ${resolverId} is already registered`);
    }

    if (registration.type === "major" && this.#resolvers.some(({ type }) => type === "major")) {
      throw new Error("A major text anchor resolver is already registered");
    }

    this.#resolvers.push({
      resolver: registration.resolver,
      ...(registration.resources !== undefined && { resources: registration.resources }),
      kind: registration.kind,
      type: registration.type,
      priority: registration.priority ?? 0,
      order: this.#resolvers.length,
      describeInPrompt: registration.describeInPrompt ?? true,
    });
  }

  public assertCanAdd(registrations: readonly TextAnchorResolverRegistration[]): void {
    const resolverIds = new Set(this.#resolvers.map(({ resolver }) => resolver.id));
    let hasMajor = this.#resolvers.some(({ type }) => type === "major");

    for (const registration of registrations) {
      if (typeof registration.kind !== "string" || registration.kind.trim().length === 0) {
        throw new TypeError("Text anchor resolver kind must be a non-empty string");
      }

      if (resolverIds.has(registration.resolver.id)) {
        throw new Error(`Text anchor resolver ${registration.resolver.id} is already registered`);
      }

      resolverIds.add(registration.resolver.id);

      if (registration.type === "major") {
        if (hasMajor) {
          throw new Error("A major text anchor resolver is already registered");
        }

        hasMajor = true;
      }
    }
  }

  public snapshot(): TextAnchorRegistrySnapshot {
    return new TextAnchorRegistrySnapshot(
      [...this.#resolvers].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      ),
    );
  }

  public renderPromptSection(): string | undefined {
    const entries = this.#resolvers
      .filter(({ describeInPrompt }) => describeInPrompt)
      .map(({ resolver }) => renderResolverDescription(resolver))
      .filter((entry): entry is string => entry !== undefined);

    return entries.length === 0
      ? undefined
      : ["Text editor anchors:", ...entries, "Pass structured anchors exactly as shown."].join(
          "\n",
        );
  }
}

export class TextAnchorRegistrySnapshot {
  public constructor(private readonly resolvers: readonly RegisteredTextAnchorResolver[]) {}

  public async inspect(
    anchors: readonly [string] | readonly [string, string],
    kinds: readonly [readonly string[]] | readonly [readonly string[], readonly string[]],
    context: TextAnchorResolverContext,
  ): Promise<TextAnchorInspectionOutcome> {
    for (let index = 0; index < anchors.length; index += 1) {
      try {
        await this.resolve(requiredValue(anchors[index]), context, new Set(kinds[index]));
      } catch (error) {
        if (!(error instanceof TextAnchorResolutionError)) {
          return { kind: "failed", reason: "Text anchor resolution failed", cause: error };
        }

        if (error.rejection === undefined) {
          return { kind: "invalid", anchorIndex: index, reason: error.message };
        }

        return {
          kind: "invalid",
          anchorIndex: index,
          reason: error.rejection.reason,
          rejectionCode: error.rejection.code,
          ...(error.rejection.contextRange !== undefined && {
            contextRange: error.rejection.contextRange,
          }),
        };
      }
    }

    return { kind: "valid" };
  }

  public async resolveResources(
    value: string,
    context: TextAnchorResourceResolverContext,
    allowedKinds?: ReadonlySet<string>,
  ): Promise<readonly TextTarget[] | undefined> {
    for (const { kind, resolver, resources } of this.resolvers) {
      if (resources === undefined || (allowedKinds !== undefined && !allowedKinds.has(kind))) {
        continue;
      }

      let attempt: unknown;

      try {
        attempt = await resources.tryResolve(value, context);
      } catch (error) {
        throw new TextAnchorResolutionError(
          `Text anchor resource resolver ${resolver.id} failed for "${value}"`,
          resolver.id,
          { cause: error },
        );
      }

      if (!isTextAnchorResourceResolutionAttempt(attempt)) {
        throw new TextAnchorResolutionError(
          `Text anchor resource resolver ${resolver.id} returned an invalid result for "${value}"`,
          resolver.id,
          { cause: attempt },
        );
      }

      if (attempt.kind === "not-handled") {
        continue;
      }

      if (attempt.kind === "failed") {
        throw new TextAnchorResolutionError(
          `Text anchor resource resolver ${resolver.id} failed for "${value}"`,
          resolver.id,
          { cause: attempt.error },
        );
      }

      if (attempt.kind === "rejected") {
        throw new TextAnchorResolutionError(
          attempt.rejection.reason,
          resolver.id,
          undefined,
          attempt.rejection,
        );
      }

      return attempt.targets;
    }

    return undefined;
  }
  public async resolve(
    value: string,
    context: TextAnchorResolverContext,
    allowedKinds?: ReadonlySet<string>,
  ): Promise<TextAnchor> {
    if (context.lines.length === 0) {
      throw new TextAnchorResolutionError(`Anchor "${value}" cannot resolve in an empty file`);
    }

    for (const { kind, resolver, type } of this.resolvers) {
      if (allowedKinds !== undefined && !allowedKinds.has(kind)) {
        continue;
      }

      let attempt: unknown;
      let normalizedValue: string;

      try {
        normalizedValue = resolver.normalize?.(value) ?? value;

        if (typeof normalizedValue !== "string" || normalizedValue.length === 0) {
          throw new TypeError("Text anchor normalization must return non-empty text");
        }

        attempt = await resolver.tryResolve(normalizedValue, context);
      } catch (error) {
        throw new TextAnchorResolutionError(
          `Text anchor resolver ${resolver.id} failed for "${value}"`,
          resolver.id,
          { cause: error },
        );
      }

      if (!isTextAnchorResolutionAttempt(attempt)) {
        throw new TextAnchorResolutionError(
          `Text anchor resolver ${resolver.id} returned an invalid result for "${value}"`,
          resolver.id,
          { cause: attempt },
        );
      }

      if (attempt.kind === "not-handled") {
        continue;
      }

      if (attempt.kind === "failed") {
        throw new TextAnchorResolutionError(
          `Text anchor resolver ${resolver.id} failed for "${value}"`,
          resolver.id,
          { cause: attempt.error },
        );
      }

      if (attempt.kind === "rejected") {
        const recoverAgain =
          resolver.recover === undefined
            ? undefined
            : (latest: TextAnchorResolverContext) =>
                runAnchorRecovery(resolver, normalizedValue, attempt.rejection, latest);
        throw new TextAnchorResolutionError(
          attempt.rejection.reason,
          resolver.id,
          undefined,
          attempt.rejection,
          undefined,
          recoverAgain,
          context,
        );
      }

      if (
        attempt.anchor.value !== normalizedValue ||
        attempt.anchor.lineNumber > context.lines.length
      ) {
        throw new TextAnchorResolutionError(
          `Text anchor resolver ${resolver.id} resolved "${value}" outside the current text`,
          resolver.id,
          { cause: attempt },
        );
      }

      if (
        TextSelectionAnchor.is(attempt.anchor) &&
        !isSelectionWithinContext(attempt.anchor, context)
      ) {
        throw new TextAnchorResolutionError(
          `Text anchor resolver ${resolver.id} resolved "${value}" outside the current text`,
          resolver.id,
          { cause: attempt },
        );
      }

      attachTextAnchorRenderer(attempt.anchor, resolver, resolver.id);

      resolvedAnchorTypes.set(attempt.anchor, type);
      return attempt.anchor;
    }

    throw new TextAnchorResolutionError(`No text anchor resolver handled "${value}"`);
  }
}

function isSelectionWithinContext(
  anchor: TextSelectionAnchor,
  context: TextAnchorResolverContext,
): boolean {
  if (anchor.source !== context.source) {
    return false;
  }

  return anchor.ranges.every((range) => {
    const startLine = context.lines[range.start.lineNumber - 1];
    const endLine = context.lines[range.end.lineNumber - 1];
    const virtualTrailingLine =
      endLine === undefined &&
      range.end.lineNumber === context.lines.length + 1 &&
      range.end.column === 0 &&
      /(?:\r\n|\r|\n)$/u.test(context.content);
    return (
      startLine !== undefined &&
      (endLine !== undefined || virtualTrailingLine) &&
      range.start.column <= startLine.length &&
      (virtualTrailingLine || range.end.column <= (endLine?.length ?? -1))
    );
  });
}

function renderResolverDescription(resolver: TextAnchorResolver): string | undefined {
  const value: unknown =
    typeof resolver.description === "string" ? resolver.description : resolver.description();

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Text anchor resolver ${resolver.id} description must be non-empty text`);
  }

  return `- ${value.trim().replaceAll("\n", " ")}`;
}

async function runAnchorRecovery(
  resolver: TextAnchorResolver,
  value: string,
  rejection: TextAnchorRejection,
  context: TextAnchorResolverContext,
): Promise<TextAnchorRecoveryOutcome> {
  if (resolver.recover === undefined) {
    return { kind: "unavailable" };
  }
  try {
    const recovered: unknown = await resolver.recover(value, { ...context, rejection });
    return isTextAnchorRecoveryOutcome(recovered) && recoveryFitsContext(recovered, context)
      ? recovered
      : {
          kind: "failed",
          error: new Error(`Text anchor resolver ${resolver.id} returned invalid recovery`),
        };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function recoveryFitsContext(
  recovery: TextAnchorRecoveryOutcome,
  context: TextAnchorResolverContext,
): boolean {
  if (recovery.kind !== "candidates" || recovery.total < recovery.candidates.length) {
    return recovery.kind !== "candidates";
  }
  return recovery.candidates.every(({ rank, range }, index) => {
    const startLine = context.lines[range.start.lineNumber - 1];
    const endLine = context.lines[range.end.lineNumber - 1];
    return (
      rank === index + 1 &&
      startLine !== undefined &&
      endLine !== undefined &&
      range.start.column <= startLine.length &&
      range.end.column <= endLine.length &&
      (range.start.lineNumber < range.end.lineNumber || range.start.column <= range.end.column)
    );
  });
}
