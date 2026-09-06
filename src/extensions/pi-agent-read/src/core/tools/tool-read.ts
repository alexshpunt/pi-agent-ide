import { requiredValue } from "pi-agent-invariant";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isAgentContent,
  isResourceResolutionAttempt,
  type ResourceResolver,
  type ResourceResolverContext,
} from "pi-agent-resource";
import {
  type PresentedTextRow,
  type TextDocument,
  type TextLine,
  type TextLinePresentation,
  type TextPresentationContext,
  isTextTargetResolutionAttempt,
  type TextTargetResolver,
  type TextTargetResolutionAttempt,
} from "pi-agent-text";
import { withBlockedToolResult } from "pi-agent-tool-call-interception";
import { Type } from "typebox";

import {
  isFragmentResolverRegistration,
  isReadFragmentResolution,
  isReadHandlerRegistration,
  isReadViewRegistration,
  isResourceResolverRegistration,
  isTextTargetResolverRegistration,
  type FragmentResolverRegistration,
  type ReadHandlerRegistration,
  type ReadPipelineContext,
  type ReadFailure,
  type ReadPipelineStage,
  type ReadResultDetails,
  type ReadResultRenderer,
  type ReadStageOutcome,
  type ReadState,
  type ReadToolResult,
  type ReadViewRegistration,
  type ResourceResolverRegistration,
  type TextTargetResolverRegistration,
} from "#src/api/tools/read.js";
import {
  limitReadOutput,
  READ_OUTPUT_MAX_BYTES,
  READ_OUTPUT_MAX_LINES,
} from "#src/core/tools/read/output-truncation.js";
import { createReadResultRenderer, renderReadCall } from "#src/core/tools/read/read-renderer.js";
import { createLineNumberPresenter } from "#src/core/tools/read/views.js";
import {
  createReadState,
  failureResult,
  projectReadState,
} from "#src/core/tools/read/read-result.js";
import { TempResourceStore } from "#src/core/tools/read/temp-resource-store.js";

const readParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Complete source resource reference: a filesystem path, URL, protocol source, temporary resource, or typed SEARCH#... selection.",
    }),
  ),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  views: Type.Optional(Type.Array(Type.String())),
});

const fallbackReadRenderer = createReadResultRenderer({ kind: "source" });

interface RegisteredResolver {
  readonly resolver: ResourceResolver;
  readonly renderResult?: ReadResultRenderer;
  readonly preserveTruncatedOutput: boolean;
  readonly priority: number;
  readonly order: number;
}

interface RegisteredHandler {
  readonly pluginId: string;
  readonly registration: ReadHandlerRegistration;
}

interface RegisteredView {
  readonly pluginId: string;
  readonly registration: ReadViewRegistration;
  readonly order: number;
}

interface RegisteredFragment {
  readonly registration: FragmentResolverRegistration;
  readonly priority: number;
  readonly order: number;
}

interface ViewContribution {
  readonly presenterId: string;
  readonly document: TextDocument;
}

/** Built-in view names that exist without any plugin registration. */
const BUILTIN_VIEWS = ["lines"] as const;

function createBuiltinViewRegistrations(): ReadViewRegistration[] {
  return [{ view: "lines", presenter: createLineNumberPresenter() }];
}

export interface ReadToolContributions {
  readonly resolvers?: readonly ResourceResolverRegistration[];
  readonly targetResolvers?: readonly TextTargetResolverRegistration[];
  readonly handlers?: readonly ReadHandlerRegistration[];
  readonly views?: readonly ReadViewRegistration[];
  readonly fragments?: readonly FragmentResolverRegistration[];
}

export interface ReadTool {
  readonly tool: ToolDefinition<typeof readParameters, ReadResultDetails>;
  execute(
    request: ReadPipelineContext["request"],
    context: ResourceResolverContext,
  ): Promise<ReadToolResult>;
  registerContributions(pluginId: string, contributions: ReadToolContributions): void;
  dispose(): Promise<void>;
}

export function createReadTool(pluginPromptGuidelines?: () => readonly string[]): ReadTool {
  const temporaryResources = new TempResourceStore();
  const resolvers: RegisteredResolver[] = [
    {
      resolver: temporaryResources.resolver,
      preserveTruncatedOutput: false,
      priority: Number.MIN_SAFE_INTEGER,
      order: 0,
    },
  ];
  const handlers: RegisteredHandler[] = [];
  const views: RegisteredView[] = createBuiltinViewRegistrations().map((registration, order) => ({
    pluginId: "core",
    registration,
    order,
  }));
  const fragments: RegisteredFragment[] = [];
  const targetResolvers: {
    readonly resolver: TextTargetResolver;
    readonly priority: number;
    readonly order: number;
  }[] = [];
  const toolId = "read";

  return {
    tool: {
      name: toolId,
      label: toolId,

      promptSnippet:
        "Read files, URLs, temporary resources, search selections, and protocol sources, with optional views projected onto text content",
      description: `Resolve a supported source into agent-native content. Text output is raw by default; pass optional views (string array) to add annotations: "lines" for a line-number column, or plugin views such as "anchors" (LINE#HASH), "ast", "diagnostics", and "changes" when their extensions are installed. Text output is truncated to ${READ_OUTPUT_MAX_LINES} lines or ${
        READ_OUTPUT_MAX_BYTES / 1024
      }KB, whichever is reached first. Use offset/limit to read a line range and continue large sources; a negative offset reads from the end. A \`path#anchor\` suffix (for example \`src/x.ts#function main\`) starts reading at the anchor's line: offset/limit then count from that line while output keeps absolute line numbers. For anchored reads, omitted offset, offset 0, and offset 1 are equivalent; positive offsets greater than one count forward and negative offsets count upward.`,
      get promptGuidelines(): string[] {
        return [
          "Use read to examine files and other supported sources instead of cat, sed, head, tail, or similar shell commands.",
          'You can use read with `views: ["lines"]` to add a line-number column.',
          "You can use read with `offset` and `limit` to inspect a line range or continue a large source, and with a negative `offset` to read from the end.",
          "You can combine compatible read views in one request.",
          "When a read result is truncated and provides a `temp:` source, you can use read with that source to continue reading the saved full output.",
          ...(pluginPromptGuidelines?.() ?? []),
        ];
      },
      parameters: readParameters,
      renderCall: renderReadCall,
      renderResult(result, options, theme, context) {
        const resolvedBy = result.details.resolvedBy;
        const renderer =
          resolvedBy === undefined
            ? undefined
            : resolvers.find(({ resolver }) => resolver.id === resolvedBy)?.renderResult;
        return (renderer ?? fallbackReadRenderer)(result, options, theme, context);
      },
      async execute(_toolCallId, parameters, signal, _onUpdate, context) {
        const resolverContext: ResourceResolverContext = {
          cwd: context.cwd,
          ...(signal !== undefined && { signal }),
        };
        return executeRead(
          parameters,
          resolverContext,
          resolvers,
          handlers,
          views,
          temporaryResources,
          fragments,
          targetResolvers,
        );
      },
    },
    execute(request, context): Promise<ReadToolResult> {
      return executeRead(
        request,
        context,
        resolvers,
        handlers,
        views,
        temporaryResources,
        fragments,
        targetResolvers,
      );
    },
    registerContributions(pluginId, contributions): void {
      const incomingResolvers = [...(contributions.resolvers ?? [])];
      const incomingTargetResolvers = [...(contributions.targetResolvers ?? [])];
      const incomingHandlers = [...(contributions.handlers ?? [])];
      const incomingViews = [...(contributions.views ?? [])];
      const incomingFragments = [...(contributions.fragments ?? [])];
      validateContributions(pluginId, incomingResolvers, incomingHandlers, resolvers, handlers);
      validateFragmentRegistrations(pluginId, incomingFragments, fragments);
      const targetResolverIds = new Set(targetResolvers.map(({ resolver }) => resolver.id));
      for (const registration of incomingTargetResolvers) {
        if (!isTextTargetResolverRegistration(registration)) {
          throw new TypeError(`Plugin ${pluginId} provided an invalid text target resolver`);
        }
        if (targetResolverIds.has(registration.resolver.id)) {
          throw new Error(`Text target resolver ${registration.resolver.id} is already registered`);
        }
        targetResolverIds.add(registration.resolver.id);
      }
      const viewNames = new Set(views.map(({ registration }) => registration.view));
      const presenterIds = new Set(
        views.map(({ registration }) => `${registration.view}/${registration.presenter.id}`),
      );

      for (const registration of incomingViews) {
        if (!isReadViewRegistration(registration)) {
          throw new TypeError(`Plugin ${pluginId} provided an invalid view registration`);
        }

        const key = `${registration.view}/${registration.presenter.id}`;

        if (presenterIds.has(key)) {
          throw new Error(
            `View ${registration.view} already has a presenter ${registration.presenter.id}`,
          );
        }

        viewNames.add(registration.view);
        presenterIds.add(key);
      }

      for (const registration of incomingResolvers) {
        resolvers.push({
          resolver: registration.resolver,
          ...(registration.renderResult !== undefined && {
            renderResult: registration.renderResult,
          }),
          priority: registration.priority ?? 0,
          preserveTruncatedOutput: registration.preserveTruncatedOutput ?? false,
          order: resolvers.length,
        });
      }

      for (const registration of incomingTargetResolvers) {
        targetResolvers.push({
          resolver: registration.resolver,
          priority: registration.priority ?? 0,
          order: targetResolvers.length,
        });
      }

      for (const registration of incomingHandlers) {
        handlers.push({ pluginId, registration });
      }

      for (const registration of incomingViews) {
        views.push({ pluginId, registration, order: views.length });
      }

      for (const registration of incomingFragments) {
        fragments.push({
          registration,
          priority: registration.priority ?? 0,
          order: fragments.length,
        });
      }
    },
    dispose(): Promise<void> {
      return temporaryResources.dispose();
    },
  };
}

async function executeRead(
  request: ReadPipelineContext["request"],
  resolverContext: ResourceResolverContext,
  resolvers: readonly RegisteredResolver[],
  handlers: readonly RegisteredHandler[],
  views: readonly RegisteredView[],
  temporaryResources: TempResourceStore,
  fragmentResolvers: readonly RegisteredFragment[],
  targetResolvers: readonly {
    readonly resolver: TextTargetResolver;
    readonly priority: number;
    readonly order: number;
  }[],
): Promise<ReadToolResult> {
  const resolverSnapshot = [...resolvers].sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  );
  const handlerSnapshot = [...handlers];
  const viewSnapshot = [...views].sort(
    (left, right) =>
      (left.registration.priority ?? 0) - (right.registration.priority ?? 0) ||
      left.order - right.order,
  );
  const fragmentSnapshot = [...fragmentResolvers].sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  );
  const targetSnapshot = [...targetResolvers].sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  );
  const requestedViews = new Set(request.views ?? []);
  const knownViews = new Set([
    ...BUILTIN_VIEWS,
    ...viewSnapshot.map(({ registration }) => registration.view),
  ]);
  const ignoredViews = [...requestedViews].filter((view) => !knownViews.has(view));
  if (request.path !== undefined && targetSnapshot.length > 0) {
    const targeted = await resolveTextTargets(
      request,
      resolverContext,
      targetSnapshot,
      resolverSnapshot,
      handlerSnapshot,
      viewSnapshot,
      requestedViews,
      ignoredViews,
    );
    if (targeted !== undefined) return targeted;
  }
  let pipeline: ReadPipelineContext = { request: { ...request }, resolverContext };

  if (!pipeline.request.path?.startsWith("temp:")) {
    const preRead = await runPreReadHandlers(pipeline, handlerSnapshot);

    if (preRead.kind === "return") {
      return withIgnoredViews(
        await limitReadOutput(preRead.result, pipeline.request),
        ignoredViews,
      );
    }

    pipeline = preRead.context;
  }

  const source = pipeline.request.path;

  if (source === undefined || source.length === 0) {
    return failureResult({ code: "INVALID_REQUEST", message: "No source was provided" });
  }

  let resolved = await resolveSource(pipeline, resolverSnapshot);
  let anchoredFragment: string | undefined;

  // Resource-first rule: when reading the whole source fails, split off an anchor fragment
  // and try the bare source. If the bare source fails too, keep the original error: a
  // resolver that claimed the full source owns its own read errors, and replacing its
  // message with the bare-source error would be misleading.
  if (
    resolved.kind === "return" &&
    resolved.result.isError === true &&
    isRetryableFailure(resolved.result) &&
    !source.startsWith("temp:")
  ) {
    const split = splitAnchoredSource(source);

    if (split !== undefined) {
      const wholeSource = { result: resolved, pipeline };
      const barePipeline = { ...pipeline, request: { ...pipeline.request, path: split.source } };
      const retried = await resolveSource(barePipeline, resolverSnapshot);

      if (retried.kind === "continue") {
        resolved = retried;
        pipeline = barePipeline;
        anchoredFragment = split.fragment;
      } else {
        resolved = wholeSource.result;
      }
    }
  }
  if (resolved.kind === "return") {
    return limitReadOutput(resolved.result, pipeline.request);
  }

  pipeline = resolved.context;

  let origin: number | undefined;

  if (anchoredFragment !== undefined) {
    const outcome = await resolveAnchoredOrigin(pipeline, fragmentSnapshot, anchoredFragment);

    if (typeof outcome !== "number") {
      return outcome;
    }

    origin = outcome;
  }

  if (pipeline.state?.textMode === "final") {
    return withIgnoredViews(
      await limitReadOutput(
        projectReadState(pipeline.state, pipeline.request, { originLine: origin }),
        pipeline.request,
        undefined,
        { originLine: origin },
      ),
      ignoredViews,
    );
  }

  const processed = await runReadHandlers(pipeline, handlerSnapshot);

  if (processed.kind === "return") {
    return withIgnoredViews(
      await limitReadOutput(processed.result, pipeline.request, undefined, { originLine: origin }),
      ignoredViews,
    );
  }

  pipeline = processed.context;
  pipeline = await runTextPresenters(pipeline, viewSnapshot, requestedViews);
  const projected = projectReadState(requiredValue(pipeline.state), pipeline.request, {
    originLine: origin,
  });
  pipeline = { ...pipeline, result: projected };
  const postRead = await runPostReadHandlers(pipeline, handlerSnapshot);
  const result =
    postRead.kind === "return" ? postRead.result : requiredValue(postRead.context.result);
  const saveFullOutput =
    pipeline.request.limit === undefined && pipeline.state?.preserveTruncatedOutput === true
      ? (text: string): Promise<string> => temporaryResources.save(text)
      : undefined;
  return withIgnoredViews(
    await limitReadOutput(result, pipeline.request, saveFullOutput, { originLine: origin }),
    ignoredViews,
  );
}

/**
 * Failures that allow the anchored-source retry. READ_FAILED is included because
 * filesystem-style resolvers read lazily inside resolution, so a missing
 * `<path>#<anchor>` file surfaces as READ_FAILED.
 */
const RETRYABLE_FAILURE_CODES: ReadonlySet<ReadFailure["code"]> = new Set([
  "INVALID_RESOLVER_RESULT",
  "NO_RESOLVER",
  "READ_FAILED",
  "RESOLVE_FAILED",
]);

/** True when reading the whole source failed for a reason an anchor split might fix. */
function isRetryableFailure(result: ReadToolResult): boolean {
  const code = result.details.failure?.code;
  return code !== undefined && RETRYABLE_FAILURE_CODES.has(code);
}

async function resolveTextTargets(
  request: ReadPipelineContext["request"],
  resolverContext: ResourceResolverContext,
  targetResolvers: readonly {
    readonly resolver: TextTargetResolver;
    readonly priority: number;
    readonly order: number;
  }[],
  resolvers: readonly RegisteredResolver[],
  handlers: readonly RegisteredHandler[],
  views: readonly RegisteredView[],
  requestedViews: ReadonlySet<string>,
  ignoredViews: readonly string[],
): Promise<ReadToolResult | undefined> {
  for (const { resolver } of targetResolvers) {
    let rawAttempt: unknown;
    try {
      rawAttempt = await resolver.tryResolve(request.path ?? "", resolverContext);
    } catch (error) {
      return failureResult({
        code: "RESOLVE_FAILED",
        source: request.path,
        message: appendErrorMessage(`Text target resolver ${resolver.id} failed`, error),
        cause: error,
      });
    }
    if (!isTextTargetResolutionAttempt(rawAttempt)) {
      return failureResult({
        code: "INVALID_RESOLVER_RESULT",
        source: request.path,
        message: `Text target resolver ${resolver.id} returned an invalid result`,
        cause: rawAttempt,
      });
    }
    const attempt: TextTargetResolutionAttempt = rawAttempt;
    if (attempt.kind === "not-handled") continue;
    if (attempt.kind === "rejected")
      return failureResult({
        code: "RESOLVE_FAILED",
        source: request.path,
        message: attempt.rejection.reason,
      });
    if (attempt.kind === "failed")
      return failureResult({
        code: "RESOLVE_FAILED",
        source: request.path,
        message: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
      });
    if (attempt.targets.length === 0)
      return failureResult({
        code: "RESOLVE_FAILED",
        source: request.path,
        message: "Text target resolver returned no targets",
      });
    const chunks: string[] = [];
    let firstDetails: ReadResultDetails | undefined;
    for (const target of attempt.targets) {
      const ranges = target.ranges ?? [
        { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 1 } },
      ];
      for (const range of ranges) {
        const rangeLimit = Math.max(1, range.end.lineNumber - range.start.lineNumber);
        let rangePipeline: ReadPipelineContext = {
          request: {
            ...request,
            path: target.source,
            limit: request.limit ?? rangeLimit,
          },
          resolverContext,
        };
        if (!target.source.startsWith("temp:")) {
          const preRead = await runPreReadHandlers(rangePipeline, handlers);
          if (preRead.kind === "return") {
            if (preRead.result.isError === true)
              return withIgnoredViews(preRead.result, ignoredViews);
            for (const block of preRead.result.content) {
              if (block.type === "text") chunks.push(block.text);
            }
            firstDetails ??= preRead.result.details;
            continue;
          }
          rangePipeline = preRead.context;
        }
        const resolved = await resolveSource(rangePipeline, resolvers);
        if (resolved.kind === "return") {
          return withIgnoredViews(resolved.result, ignoredViews);
        }
        const processed = await runReadHandlers(resolved.context, handlers);
        if (processed.kind === "return") {
          if (processed.result.isError === true)
            return withIgnoredViews(processed.result, ignoredViews);
          for (const block of processed.result.content) {
            if (block.type === "text") chunks.push(block.text);
          }
          firstDetails ??= processed.result.details;
          continue;
        }
        const presented = await runTextPresenters(processed.context, views, requestedViews);
        const projected = projectReadState(requiredValue(presented.state), presented.request, {
          originLine: range.start.lineNumber,
        });
        const postRead = await runPostReadHandlers({ ...presented, result: projected }, handlers);
        if (projected.isError === true) return withIgnoredViews(projected, ignoredViews);
        const result =
          postRead.kind === "return" ? postRead.result : requiredValue(postRead.context.result);
        if (result.isError === true) return withIgnoredViews(result, ignoredViews);
        for (const block of result.content) {
          if (block.type === "text") chunks.push(block.text);
        }
        firstDetails ??= result.details;
      }
    }
    const aggregate = {
      content: [{ type: "text", text: chunks.join("\n") }],
      details: firstDetails ?? { source: request.path },
    } satisfies ReadToolResult;
    return withIgnoredViews(
      await limitReadOutput(aggregate, { path: request.path, views: request.views }),
      ignoredViews,
    );
  }
  return undefined;
}

const ANCHOR_SEPARATOR = "#";

/** Splits `path#fragment`; returns undefined when there is nothing to anchor. */
function splitAnchoredSource(
  source: string,
): { readonly source: string; readonly fragment: string } | undefined {
  const index = source.indexOf(ANCHOR_SEPARATOR);

  if (index <= 0 || index === source.length - 1) {
    return undefined;
  }

  return {
    source: source.slice(0, index),
    fragment: source.slice(index + ANCHOR_SEPARATOR.length),
  };
}

type AnchoredOriginOutcome = number | ReadToolResult;

async function resolveAnchoredOrigin(
  pipeline: ReadPipelineContext,
  fragments: readonly RegisteredFragment[],
  fragment: string,
): Promise<AnchoredOriginOutcome> {
  const state = requiredValue(pipeline.state);

  if (state.contentKind !== "text") {
    return failureResult({
      code: "UNSUPPORTED_RANGE",
      source: state.source,
      resolverId: state.resolvedBy,
      message: "Anchored reads require textual content",
    });
  }

  if (fragments.length === 0) {
    return failureResult({
      code: "NO_FRAGMENT_RESOLVER",
      source: state.source,
      message: `No fragment resolver is registered for anchor "${fragment}"`,
    });
  }

  for (const { registration } of fragments) {
    let outcome: unknown;

    try {
      outcome = await registration.resolve({
        source: state.source,
        fragment,
        text: state.text,
        cwd: pipeline.resolverContext.cwd,
        ...(pipeline.resolverContext.signal !== undefined && {
          signal: pipeline.resolverContext.signal,
        }),
      });
    } catch (error) {
      return failureResult({
        code: "FRAGMENT_FAILED",
        source: state.source,
        resolverId: registration.id,
        message: appendErrorMessage(`Fragment resolver ${registration.id} failed`, error),
        cause: error,
      });
    }

    if (!isReadFragmentResolution(outcome)) {
      return failureResult({
        code: "INVALID_RESOLVER_RESULT",
        source: state.source,
        resolverId: registration.id,
        message: `Fragment resolver ${registration.id} returned an invalid result`,
        cause: outcome,
      });
    }

    if (outcome.kind === "not-handled") {
      continue;
    }

    if (outcome.kind === "failed") {
      return failureResult({
        code: "FRAGMENT_FAILED",
        source: state.source,
        resolverId: registration.id,
        message: outcome.message,
      });
    }

    if (
      !Number.isInteger(outcome.originLine) ||
      outcome.originLine < 1 ||
      outcome.originLine > state.text.lines.length
    ) {
      return failureResult({
        code: "INVALID_RESOLVER_RESULT",
        source: state.source,
        resolverId: registration.id,
        message: `Fragment resolver ${registration.id} returned out-of-range origin line ${outcome.originLine}`,
      });
    }

    return outcome.originLine;
  }

  return failureResult({
    code: "NO_FRAGMENT_RESOLVER",
    source: state.source,
    message: `No fragment resolver handled anchor "${fragment}"`,
  });
}

async function resolveSource(
  initialContext: ReadPipelineContext,
  resolvers: readonly RegisteredResolver[],
): Promise<ReadStageOutcome> {
  const source = requiredValue(initialContext.request.path);
  const resolverContext = initialContext.resolverContext;

  for (const registeredResolver of resolvers) {
    const { resolver } = registeredResolver;
    let attempt: unknown;

    try {
      attempt = await resolver.tryResolve(source, resolverContext);
    } catch (error) {
      return {
        kind: "return",
        result: failureResult({
          code: "RESOLVE_FAILED",
          source,
          resolverId: resolver.id,
          message: appendErrorMessage(`Resolver ${resolver.id} failed`, error),
          cause: error,
        }),
      };
    }

    if (!isResourceResolutionAttempt(attempt)) {
      return {
        kind: "return",
        result: failureResult({
          code: "INVALID_RESOLVER_RESULT",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} returned an invalid result`,
          cause: attempt,
        }),
      };
    }

    if (attempt.kind === "not-handled") {
      continue;
    }

    if (attempt.kind === "failed") {
      return {
        kind: "return",
        result: failureResult({
          code: "RESOLVE_FAILED",
          source,
          resolverId: resolver.id,
          message: appendErrorMessage(`Resolver ${resolver.id} failed`, attempt.error),
          cause: attempt.error,
        }),
      };
    }

    const resource = attempt.resource;

    if (resource.read === undefined) {
      return {
        kind: "return",
        result: failureResult({
          code: "UNSUPPORTED_CAPABILITY",
          source: resource.source,
          resolverId: resolver.id,
          message: `Resource ${resource.source} does not support reading`,
        }),
      };
    }

    let content: unknown;

    try {
      content = await resource.read({
        ...(resolverContext.signal !== undefined && { signal: resolverContext.signal }),
      });
    } catch (error) {
      return {
        kind: "return",
        result: failureResult({
          code: "READ_FAILED",
          source: resource.source,
          resolverId: resolver.id,
          message: appendErrorMessage(`Unable to read ${resource.source}`, error),
          cause: error,
        }),
      };
    }

    if (!isAgentContent(content)) {
      return {
        kind: "return",
        result: failureResult({
          code: "INVALID_RESOURCE_CONTENT",
          source: resource.source,
          resolverId: resolver.id,
          message: `Resource ${resource.source} returned invalid content`,
          cause: content,
        }),
      };
    }

    return {
      kind: "continue",
      context: {
        ...initialContext,
        state: createReadState(content, resource.source, resolver.id, {
          preserveTruncatedOutput: registeredResolver.preserveTruncatedOutput,
          textMode: resolver.id === "temp" ? "final" : "normal",
        }),
      },
    };
  }

  const reason = `No resolver handled ${source}`;
  return {
    kind: "return",
    result: withBlockedToolResult(
      failureResult({
        code: "NO_RESOLVER",
        source,
        message: reason,
      }),
      reason,
    ),
  };
}

async function runPreReadHandlers(
  initialContext: ReadPipelineContext,
  handlers: readonly RegisteredHandler[],
): Promise<ReadStageOutcome> {
  let context = initialContext;

  for (const registered of handlers) {
    if (registered.registration.stage !== "pre-read") {
      continue;
    }

    const outcome = await invokeHandler(
      registered.registration.handler,
      context,
      registered.pluginId,
      "pre-read",
    );

    if (outcome.kind === "return") {
      return outcome;
    }

    context = outcome.context;
  }

  return { kind: "continue", context };
}

async function runReadHandlers(
  initialContext: ReadPipelineContext,
  handlers: readonly RegisteredHandler[],
): Promise<ReadStageOutcome> {
  const initialState = initialContext.state;
  const matchingHandlers =
    initialState === undefined
      ? []
      : handlers.filter(
          (registered) =>
            registered.registration.stage === "read" &&
            matchesReadState(registered.registration, initialState),
        );
  let context = initialContext;

  for (const registered of matchingHandlers) {
    const registration = registered.registration;

    if (registration.stage !== "read") {
      continue;
    }

    const outcome = await invokeHandler(registration.handler, context, registered.pluginId, "read");

    if (outcome.kind === "return") {
      return outcome;
    }

    context = outcome.context;
  }

  return { kind: "continue", context };
}

async function runTextPresenters(
  context: ReadPipelineContext,
  views: readonly RegisteredView[],
  requestedViews: ReadonlySet<string>,
): Promise<ReadPipelineContext> {
  const state = context.state;

  if (state?.contentKind !== "text" || requestedViews.size === 0) {
    return context;
  }

  const document = state.text;
  const presentationContext: TextPresentationContext = {
    purpose: "read",
    source: state.source,
    cwd: context.resolverContext.cwd,
    resolvedBy: state.resolvedBy,
    ...(context.resolverContext.signal !== undefined && { signal: context.resolverContext.signal }),
  };
  const requestedRegistrations = views.filter(({ registration }) =>
    requestedViews.has(registration.view),
  );
  const includedViews = new Set(
    requestedRegistrations.flatMap(({ registration }) => registration.includes ?? []),
  );
  const activeViews = requestedRegistrations.filter(
    ({ registration }) => !includedViews.has(registration.view),
  );
  const contributions = await Promise.all(
    activeViews.map(async ({ registration }) => ({
      presenterId: registration.presenter.id,
      document: await registration.presenter.present(document, presentationContext),
    })),
  );
  const presented = mergeViewContributions(document, contributions);

  return { ...context, state: { ...state, text: presented } };
}

/** Prepends a note listing unknown view names so the agent can correct the request. */
function withIgnoredViews(result: ReadToolResult, ignoredViews: readonly string[]): ReadToolResult {
  if (ignoredViews.length === 0) {
    return result;
  }

  const note = `note: ignored unknown views: ${ignoredViews.join(", ")}`;
  const block = result.content[0];
  const content =
    block?.type === "text" ? [{ ...block, text: `${note}\n${block.text}` }] : [...result.content];

  return {
    ...result,
    content,
    details: { ...result.details, ignoredViews },
  };
}

function mergeViewContributions(
  base: TextDocument,
  contributions: readonly ViewContribution[],
): TextDocument {
  let lines = base.lines;

  for (const contribution of contributions) {
    assertPresentationOnly(base, contribution);
    lines = lines.map((line, index) =>
      mergePresentedLine(
        requiredValue(base.lines[index]),
        line,
        requiredValue(contribution.document.lines[index]),
      ),
    );
  }

  return lines === base.lines ? base : { ...base, lines };
}

function assertPresentationOnly(base: TextDocument, contribution: ViewContribution): void {
  const presented = contribution.document;

  if (
    presented.source !== base.source ||
    presented.content !== base.content ||
    presented.lines.length !== base.lines.length
  ) {
    throw new Error(`Text presenter ${contribution.presenterId} changed canonical text`);
  }

  for (const [index, line] of presented.lines.entries()) {
    const baseLine = requiredValue(base.lines[index]);

    if (
      line.lineNumber !== baseLine.lineNumber ||
      line.content !== baseLine.content ||
      line.lineEnding !== baseLine.lineEnding
    ) {
      throw new Error(`Text presenter ${contribution.presenterId} changed canonical text`);
    }
  }
}

function mergePresentedLine(base: TextLine, current: TextLine, contribution: TextLine): TextLine {
  const presentation = mergeLinePresentation(
    base.presentation,
    current.presentation,
    contribution.presentation,
  );
  const metadata = mergeLineMetadata(base.metadata, current.metadata, contribution.metadata);

  if (presentation === current.presentation && metadata === current.metadata) {
    return current;
  }

  return {
    ...current,
    ...(presentation !== undefined && { presentation }),
    ...(metadata !== undefined && { metadata }),
  };
}

function mergeLinePresentation(
  base: TextLinePresentation | undefined,
  current: TextLinePresentation | undefined,
  contribution: TextLinePresentation | undefined,
): TextLinePresentation | undefined {
  if (contribution === base) {
    return current;
  }

  const prefix = mergePresentedText(base?.prefix, current?.prefix, contribution?.prefix);
  const suffix = mergePresentedText(base?.suffix, current?.suffix, contribution?.suffix);
  const before = mergePresentedRows(base?.before, current?.before, contribution?.before);
  const after = mergePresentedRows(base?.after, current?.after, contribution?.after);
  const marker = contribution?.marker === base?.marker ? current?.marker : contribution?.marker;

  if (
    prefix === current?.prefix &&
    suffix === current?.suffix &&
    before === current?.before &&
    after === current?.after &&
    marker === current?.marker
  ) {
    return current;
  }

  return {
    ...current,
    ...(prefix !== undefined && { prefix }),
    ...(suffix !== undefined && { suffix }),
    ...(before !== undefined && { before }),
    ...(after !== undefined && { after }),
    ...(marker !== undefined && { marker }),
  };
}

function mergePresentedText(
  base: string | undefined,
  current: string | undefined,
  contribution: string | undefined,
): string | undefined {
  if (contribution === base) {
    return current;
  }

  const baseText = base ?? "";
  const currentText = current ?? "";
  const contributionText = contribution ?? "";

  if (baseText.length > 0 && contributionText.startsWith(baseText)) {
    return `${currentText}${contributionText.slice(baseText.length)}`;
  }

  if (baseText.length > 0 && contributionText.endsWith(baseText)) {
    return `${contributionText.slice(0, -baseText.length)}${currentText}`;
  }

  return `${currentText}${contributionText}`;
}

function mergePresentedRows(
  base: readonly PresentedTextRow[] | undefined,
  current: readonly PresentedTextRow[] | undefined,
  contribution: readonly PresentedTextRow[] | undefined,
): readonly PresentedTextRow[] | undefined {
  if (contribution === base) {
    return current;
  }

  const baseRows = base ?? [];
  const currentRows = current ?? [];
  const contributionRows = contribution ?? [];

  if (startsWithRows(contributionRows, baseRows)) {
    return [...currentRows, ...contributionRows.slice(baseRows.length)];
  }

  if (endsWithRows(contributionRows, baseRows)) {
    return [
      ...contributionRows.slice(0, contributionRows.length - baseRows.length),
      ...currentRows,
    ];
  }

  return [...currentRows, ...contributionRows];
}

function startsWithRows(
  rows: readonly PresentedTextRow[],
  prefix: readonly PresentedTextRow[],
): boolean {
  return (
    prefix.length > 0 &&
    prefix.length <= rows.length &&
    prefix.every((row, index) => rows[index] === row)
  );
}

function endsWithRows(
  rows: readonly PresentedTextRow[],
  suffix: readonly PresentedTextRow[],
): boolean {
  const offset = rows.length - suffix.length;
  return (
    suffix.length > 0 && offset >= 0 && suffix.every((row, index) => rows[offset + index] === row)
  );
}

function mergeLineMetadata(
  base: TextLine["metadata"],
  current: TextLine["metadata"],
  contribution: TextLine["metadata"],
): TextLine["metadata"] {
  if (contribution === base || contribution === undefined) {
    return current;
  }

  const additions = Object.fromEntries(
    Object.entries(contribution).filter(([key, value]) => base?.[key] !== value),
  );

  return Object.keys(additions).length === 0 ? current : { ...current, ...additions };
}

async function runPostReadHandlers(
  initialContext: ReadPipelineContext,
  handlers: readonly RegisteredHandler[],
): Promise<ReadStageOutcome> {
  let context = initialContext;

  for (const registered of handlers) {
    if (registered.registration.stage !== "post-read") {
      continue;
    }

    const outcome = await invokeHandler(
      registered.registration.handler,
      context,
      registered.pluginId,
      "post-read",
    );

    if (outcome.kind === "return") {
      return outcome;
    }

    context = outcome.context;
  }

  return { kind: "continue", context };
}

async function invokeHandler(
  handler: (context: ReadPipelineContext) => ReadStageOutcome | Promise<ReadStageOutcome>,
  context: ReadPipelineContext,
  pluginId: string,
  stage: ReadPipelineStage,
): Promise<ReadStageOutcome> {
  try {
    return await handler(context);
  } catch (error) {
    return {
      kind: "return",
      result: failureResult({
        code: "PIPELINE_FAILED",
        ...(context.state?.source === undefined
          ? context.result?.details.source === undefined
            ? {}
            : { source: context.result.details.source }
          : { source: context.state.source }),
        pluginId,
        stage,
        message: `Plugin ${pluginId} failed during ${stage}`,
        cause: error,
      }),
    };
  }
}

function matchesReadState(
  registration: Extract<ReadHandlerRegistration, { readonly stage: "read" }>,
  state: ReadState,
): boolean {
  return (
    (registration.when.resolvedBy === "any" || registration.when.resolvedBy === state.resolvedBy) &&
    (registration.when.contentKind === "any" || registration.when.contentKind === state.contentKind)
  );
}

function validateContributions(
  pluginId: string,
  incomingResolvers: readonly ResourceResolverRegistration[],
  incomingHandlers: readonly ReadHandlerRegistration[],
  registeredResolvers: readonly RegisteredResolver[],
  registeredHandlers: readonly RegisteredHandler[],
): void {
  const resolverIds = new Set(registeredResolvers.map(({ resolver }) => resolver.id));

  for (const registration of incomingResolvers) {
    if (!isResourceResolverRegistration(registration)) {
      throw new TypeError(`Plugin ${pluginId} provided an invalid resource resolver`);
    }

    if (resolverIds.has(registration.resolver.id)) {
      throw new Error(`Resource resolver ${registration.resolver.id} is already registered`);
    }

    resolverIds.add(registration.resolver.id);
  }

  const stages = new Set(
    registeredHandlers
      .filter((handler) => handler.pluginId === pluginId)
      .map((handler) => handler.registration.stage),
  );

  for (const registration of incomingHandlers) {
    if (!isReadHandlerRegistration(registration)) {
      throw new TypeError(`Plugin ${pluginId} provided an invalid read handler`);
    }

    if (stages.has(registration.stage)) {
      throw new Error(`Plugin ${pluginId} already handles ${registration.stage}`);
    }

    stages.add(registration.stage);
  }
}

function validateFragmentRegistrations(
  pluginId: string,
  incoming: readonly FragmentResolverRegistration[],
  registered: readonly RegisteredFragment[],
): void {
  const ids = new Set(registered.map(({ registration }) => registration.id));

  for (const registration of incoming) {
    if (!isFragmentResolverRegistration(registration)) {
      throw new TypeError(`Plugin ${pluginId} provided an invalid fragment resolver`);
    }

    if (ids.has(registration.id)) {
      throw new Error(`Fragment resolver ${registration.id} is already registered`);
    }

    ids.add(registration.id);
  }
}
function appendErrorMessage(message: string, cause: unknown): string {
  if (!(cause instanceof Error) || cause.message.length === 0) {
    return message;
  }

  return `${message}: ${cause.message}`;
}
