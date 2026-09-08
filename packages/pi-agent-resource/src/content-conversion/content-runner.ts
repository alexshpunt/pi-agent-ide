import {
  isContentConversionAttempt,
  isContentConversionContext,
  isContentConverterRegistration,
  isContentInput,
  isContentTarget,
} from "./validation.js";

import type {
  ContentConversionContext,
  ContentConverter,
  ContentConverterRegistration,
  ContentDescription,
  ContentInput,
  ContentTarget,
} from "./content-converter.js";
import type { AgentContent } from "#src/content.js";

interface RegisteredConverter {
  readonly converter: ContentConverter;
  readonly priority: number;
  readonly order: number;
}

export interface ContentRunner {
  readonly target: ContentTarget;
  register(registration: ContentConverterRegistration): void;
  listDescriptions(): readonly ContentDescription[];
  convert(input: ContentInput, context: ContentConversionContext): Promise<AgentContent>;
}

export class UnsupportedContentError extends Error {
  readonly source: string;
  readonly target: ContentTarget;

  constructor(source: string, target: ContentTarget) {
    super(`No content converter for ${source} in ${target.provider}/${target.capability}`);
    this.name = "UnsupportedContentError";
    this.source = source;
    this.target = target;
  }
}

export function createContentRunner(target: ContentTarget): ContentRunner {
  if (!isContentTarget(target)) {
    throw new TypeError("Invalid content target");
  }

  const stableTarget: ContentTarget = { ...target };
  const converters: RegisteredConverter[] = [];
  const snapshotConverters = (): RegisteredConverter[] =>
    [...converters].sort(
      (left, right) => left.priority - right.priority || left.order - right.order,
    );

  return {
    target: stableTarget,
    register(registration): void {
      if (!isContentConverterRegistration(registration)) {
        throw new TypeError("Invalid content converter registration");
      }

      if (!targetsEqual(stableTarget, registration.target)) {
        throw new Error(
          `Content converter ${registration.converter.id} targets ` +
            `${registration.target.provider}/${registration.target.capability}, not ` +
            `${stableTarget.provider}/${stableTarget.capability}`,
        );
      }

      if (converters.some(({ converter }) => converter.id === registration.converter.id)) {
        throw new Error(
          `Content converter ${registration.converter.id} is already registered for ` +
            `${stableTarget.provider}/${stableTarget.capability}`,
        );
      }

      converters.push({
        converter: registration.converter,
        priority: registration.priority ?? 0,
        order: converters.length,
      });
    },
    listDescriptions(): readonly ContentDescription[] {
      return snapshotConverters().map(({ converter }) => ({
        id: converter.id,
        description: converter.description,
      }));
    },
    async convert(input, context): Promise<AgentContent> {
      if (!isContentInput(input)) {
        throw new TypeError("Invalid content input");
      }

      if (!isContentConversionContext(context)) {
        throw new TypeError("Invalid content conversion context");
      }

      throwIfAborted(context.signal);
      const snapshot = snapshotConverters();

      for (const { converter } of snapshot) {
        throwIfAborted(context.signal);
        const attempt: unknown = await converter.tryConvert(input, context);
        throwIfAborted(context.signal);

        if (!isContentConversionAttempt(attempt)) {
          throw new TypeError(`Content converter ${converter.id} returned an invalid outcome`);
        }

        if (attempt.kind === "not-handled") {
          continue;
        }

        if (attempt.kind === "failed") {
          throw attempt.error;
        }

        return attempt.content;
      }

      throw new UnsupportedContentError(input.source, stableTarget);
    },
  };
}

export function targetsEqual(left: ContentTarget, right: ContentTarget): boolean {
  return left.provider === right.provider && left.capability === right.capability;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
