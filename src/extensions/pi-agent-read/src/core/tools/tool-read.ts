import { requiredValue } from "../../../../../utils/required-value.js";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isAgentContent,
  isResourceResolutionAttempt,
  type ResourceResolver,
  type ResourceResolverContext,
} from "pi-agent-resource";
import {
  isTextPresenterRegistration,
  type PresentedTextRow,
  type TextDocument,
  type TextLine,
  type TextLinePresentation,
  type TextPresentationContext,
  type TextPresenterRegistration,
} from "pi-agent-text";
import { withBlockedToolResult } from "pi-agent-tool-call-interception";
import { Type } from "typebox";

import {
  isReadHandlerRegistration,
  isResourceResolverRegistration,
  type ReadHandlerRegistration,
  type ReadPipelineContext,
  type ReadPipelineStage,
  type ReadResultDetails,
  type ReadResultRenderer,
  type ReadStageOutcome,
  type ReadState,
  type ReadToolResult,
  type ResourceResolverRegistration,
} from "#src/api/tools/read.js";
import {
  limitReadOutput,
  READ_OUTPUT_MAX_BYTES,
  READ_OUTPUT_MAX_LINES,
} from "#src/core/tools/read/output-truncation.js";
import { createReadResultRenderer } from "#src/core/tools/read/read-renderer.js";
import {
  createReadState,
  failureResult,
  projectReadState,
} from "#src/core/tools/read/read-result.js";
import { TempResourceStore } from "#src/core/tools/read/temp-resource-store.js";

const readParameters = Type.Object({
  path: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
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

interface RegisteredPresenter {
  readonly pluginId: string;
  readonly registration: TextPresenterRegistration;
  readonly order: number;
}

interface TextPresenterContribution {
  readonly presenterId: string;
  readonly document: TextDocument;
}

export interface ReadToolContributions {
  readonly resolvers?: readonly ResourceResolverRegistration[];
  readonly handlers?: readonly ReadHandlerRegistration[];
  readonly presenters?: readonly TextPresenterRegistration[];
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

export function createReadTool(pluginPromptGuideline?: () => string | undefined): ReadTool {
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
  const presenters: RegisteredPresenter[] = [];
  const toolId = "read";

  return {
    tool: {
      name: toolId,
      label: toolId,
      description: `Resolve a supported source into agent-native content. Text output is truncated to ${READ_OUTPUT_MAX_LINES} lines or ${
        READ_OUTPUT_MAX_BYTES / 1024
      }KB, whichever is reached first. Use offset/limit to read a line range and continue large sources; a negative offset reads from the end.`,
      get promptGuidelines(): string[] {
        const pluginGuideline = pluginPromptGuideline?.();
        return [
          "For large sources, prefer focused or structural reads over full content.",
          ...(pluginGuideline === undefined ? [] : [pluginGuideline]),
        ];
      },
      parameters: readParameters,
      renderShell: "self",
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
          presenters,
          temporaryResources,
        );
      },
    },
    execute(request, context): Promise<ReadToolResult> {
      return executeRead(request, context, resolvers, handlers, presenters, temporaryResources);
    },
    registerContributions(pluginId, contributions): void {
      const incomingResolvers = [...(contributions.resolvers ?? [])];
      const incomingHandlers = [...(contributions.handlers ?? [])];
      const incomingPresenters = [...(contributions.presenters ?? [])];
      validateContributions(pluginId, incomingResolvers, incomingHandlers, resolvers, handlers);
      const presenterIds = new Set(presenters.map(({ registration }) => registration.presenter.id));

      for (const registration of incomingPresenters) {
        if (!isTextPresenterRegistration(registration)) {
          throw new TypeError(`Plugin ${pluginId} provided an invalid text presenter`);
        }

        if (presenterIds.has(registration.presenter.id)) {
          throw new Error(`Text presenter ${registration.presenter.id} is already registered`);
        }

        presenterIds.add(registration.presenter.id);
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

      for (const registration of incomingHandlers) {
        handlers.push({ pluginId, registration });
      }

      for (const registration of incomingPresenters) {
        presenters.push({ pluginId, registration, order: presenters.length });
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
  presenters: readonly RegisteredPresenter[],
  temporaryResources: TempResourceStore,
): Promise<ReadToolResult> {
  const resolverSnapshot = [...resolvers].sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  );
  const handlerSnapshot = [...handlers];
  const presenterSnapshot = [...presenters].sort(
    (left, right) =>
      (left.registration.priority ?? 0) - (right.registration.priority ?? 0) ||
      left.order - right.order,
  );
  let pipeline: ReadPipelineContext = { request: { ...request }, resolverContext };

  if (!pipeline.request.path?.startsWith("temp:")) {
    const preRead = await runPreReadHandlers(pipeline, handlerSnapshot);

    if (preRead.kind === "return") {
      return limitReadOutput(preRead.result, pipeline.request);
    }

    pipeline = preRead.context;
  }

  const source = pipeline.request.path;

  if (source === undefined || source.length === 0) {
    return failureResult({ code: "INVALID_REQUEST", message: "No source was provided" });
  }

  const resolved = await resolveSource(pipeline, resolverSnapshot);

  if (resolved.kind === "return") {
    return limitReadOutput(resolved.result, pipeline.request);
  }

  pipeline = resolved.context;

  if (pipeline.state?.textMode === "final") {
    return limitReadOutput(projectReadState(pipeline.state, pipeline.request), pipeline.request);
  }

  const processed = await runReadHandlers(pipeline, handlerSnapshot);

  if (processed.kind === "return") {
    return limitReadOutput(processed.result, pipeline.request);
  }

  pipeline = processed.context;
  pipeline = await runTextPresenters(pipeline, presenterSnapshot);
  const projected = projectReadState(requiredValue(pipeline.state), pipeline.request);
  pipeline = { ...pipeline, result: projected };
  const postRead = await runPostReadHandlers(pipeline, handlerSnapshot);
  const result =
    postRead.kind === "return" ? postRead.result : requiredValue(postRead.context.result);
  const saveFullOutput =
    pipeline.request.limit === undefined && pipeline.state?.preserveTruncatedOutput === true
      ? (text: string): Promise<string> => temporaryResources.save(text)
      : undefined;
  return limitReadOutput(result, pipeline.request, saveFullOutput);
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
  presenters: readonly RegisteredPresenter[],
): Promise<ReadPipelineContext> {
  const state = context.state;

  if (state?.contentKind !== "text") {
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
  const contributions = await Promise.all(
    presenters.map(async ({ registration }) => ({
      presenterId: registration.presenter.id,
      document: await registration.presenter.present(document, presentationContext),
    })),
  );
  const presented = mergeTextPresenterContributions(document, contributions);

  return { ...context, state: { ...state, text: presented } };
}

function mergeTextPresenterContributions(
  base: TextDocument,
  contributions: readonly TextPresenterContribution[],
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

function assertPresentationOnly(base: TextDocument, contribution: TextPresenterContribution): void {
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

function appendErrorMessage(message: string, cause: unknown): string {
  if (!(cause instanceof Error) || cause.message.length === 0) {
    return message;
  }

  return `${message}: ${cause.message}`;
}
