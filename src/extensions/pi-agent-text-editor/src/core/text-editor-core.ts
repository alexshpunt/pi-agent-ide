import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { deferPostEdit, collectPostEditNotifications } from "#src/core/post-edit-scope.js";
import { requiredValue } from "pi-agent-invariant";
import {
  isAgentContent,
  isResourceResolutionAttempt,
  resourceScheduler,
  resourceAccesses,
  type ResourceAccess,
  type ResourceResolutionAttempt,
  type Resource,
  type ResourceResolver,
  type ResourceResolverContext,
} from "pi-agent-resource";
import {
  createTextDocument,
  isTextPresenterRegistration,
  type TextAnchor,
  type TextAnchorResolverContext,
  type TextDocument,
  type TextPresentationContext,
  type TextPresenterRegistration,
  type TextTarget,
  type TextTargetResolver,
} from "pi-agent-text";

import {
  isTextEditHandlerRegistration,
  type TextEditExecutionOutcome,
  type TextEditHandlerRegistration,
  type TextEditorToolPluginApi,
  type TextEditPipelineFailure,
  type TextEditPipelineStage,
  type TextEditState,
  type TextPreEditState,
} from "#src/api/edit-pipeline.js";
import {
  type AnyTextMutationToolRegistration,
  assertTextMutationToolRegistration,
  type TextMutationToolListener,
  type TextSemanticMutationHandler,
} from "#src/api/mutation-tool.js";
import {
  isResourceResolverRegistration,
  isTextAnchorResolverRegistration,
  isTextEditorToolId,
  type PromptDescriptionSource,
  type ResourceResolverRegistration,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextAnchorResolverRegistration,
  type TextAnchorResourceResolverContext,
  type TextEditorPlugin,
  type TextEditorPluginApi,
  type TextEditorRecoveryConfigSection,
  type TextEditorToolId,
} from "#src/api/plugin-protocol.js";
import {
  isTextPostEditHandlerRegistration,
  type TextPostEditContribution,
  type TextPostEditHandlerRegistration,
  type TextPostEditTransaction,
} from "#src/api/post-edit.js";
import {
  isTextEditorToolRendererRegistration,
  type TextEditorToolRendererRegistration,
} from "#src/api/tool-renderer.js";
import {
  TextAnchorRegistry,
  type TextAnchorRegistrySnapshot,
} from "#src/core/text-anchor-registry.js";
import {
  applyTextChanges,
  type TextChange,
  type TextChangeResult,
} from "#src/core/text-change-engine.js";
import { previewTextMutation } from "#src/core/text-mutation.js";
import { loadTextEditorConfig, recoverySection } from "#src/core/text-editor-config.js";

import type {
  TextAnchorInspectionOutcome,
  TextAnchorInspectionRequest,
} from "#src/api/anchor-inspection.js";
import type {
  TextEditCompletion,
  TextEditCompletionListener,
  TextEditIntent,
} from "#src/api/edit-completion.js";
import type {
  TextMutationGuardContext,
  TextMutationGuardRegistration,
  TextMutationPlan,
} from "#src/api/mutation-guard.js";
import type {
  TextMutationPreviewOutcome,
  TextMutationPreviewRequest,
} from "#src/api/mutation-preview.js";

type PluginStatus = "active" | "pending";

interface PluginLifecycle {
  status: PluginStatus;
}

interface RegisteredPlugin {
  readonly lifecycle: PluginLifecycle;
  readonly plugin: TextEditorPlugin;
  readonly ready: Promise<void>;
}

interface RegisteredSemanticHandler {
  readonly pluginId: string;
  readonly handler: TextSemanticMutationHandler;
  readonly tool: TextEditorToolId;
}
interface RegisteredHandler {
  readonly pluginId: string;
  readonly registration: TextEditHandlerRegistration;
  readonly tool: TextEditorToolId;
}

interface RegisteredResolver {
  readonly resolver: ResourceResolver;
  readonly priority: number;
  readonly order: number;
}

/** Resolve owners once before scheduling, without reading or modifying their contents. */
function scopedResolvers(
  sources: readonly string[],
  context: ResourceResolverContext,
  resolvers: readonly RegisteredResolver[],
  mode: ResourceAccess["mode"] = "write",
): {
  resolvers: readonly RegisteredResolver[];
  accesses: Promise<readonly ResourceAccess[] | undefined>;
} {
  const cached = resolvers.map((registered) => {
    const attempts = new Map<string, Promise<ResourceResolutionAttempt>>();
    return {
      ...registered,
      resolver: {
        ...registered.resolver,
        tryResolve(source: string, request: ResourceResolverContext) {
          let pending = attempts.get(source);
          if (pending === undefined) {
            pending = registered.resolver.tryResolve(source, request);
            attempts.set(source, pending);
          }
          return pending;
        },
      },
    };
  });
  const accesses = Promise.all(
    sources.map(async (source) => {
      try {
        for (const { resolver } of cached) {
          const attempt = await resolver.tryResolve(source, context);
          if (!isResourceResolutionAttempt(attempt)) return undefined;
          if (attempt.kind === "not-handled") continue;
          if (attempt.kind === "failed") return undefined;
          return await resourceAccesses(attempt.resource.source, context.cwd, mode);
        }
      } catch {
        // Let the normal edit pipeline report the cached resolution failure.
      }
      return undefined;
    }),
  ).then((sets) =>
    sets.some((set) => set === undefined) ? undefined : sets.flatMap((set) => set ?? []),
  );
  return { resolvers: cached, accesses };
}
interface ResolverContribution {
  readonly pluginId: string;
  readonly registration: ResourceResolverRegistration;
}

interface TextAnchorResolverContribution {
  readonly pluginId: string;
  readonly registration: TextAnchorResolverRegistration;
}

interface TextPresenterContribution {
  readonly pluginId: string;
  readonly registration: TextPresenterRegistration;
}

interface RegisteredPresenter extends TextPresenterContribution {
  readonly order: number;
}
interface PromptContribution {
  readonly description: string;
  readonly pluginId: string;
  readonly tool: TextEditorToolId;
}

interface WritablePromptContribution {
  readonly description: PromptDescriptionSource;
  readonly pluginId: string;
}

interface PluginContributionDraft {
  readonly resolvers: ResolverContribution[];
  readonly anchorResolvers: TextAnchorResolverContribution[];
  readonly presenters?: TextPresenterContribution[];
  readonly handlers: RegisteredHandler[];
  readonly semanticHandlers?: RegisteredSemanticHandler[];
  readonly promptContributions: PromptContribution[];
  readonly writablePromptContributions: WritablePromptContribution[];
  readonly tools: TextEditorToolId[];
  readonly mutationTools?: AnyTextMutationToolRegistration[];
  readonly mutationToolListeners?: TextMutationToolListener[];
  readonly editCompletionListeners?: TextEditCompletionListener[];
  readonly mutationGuards?: TextMutationGuardRegistration[];
  readonly toolRenderers?: TextEditorToolRendererRegistration[];
}

interface PluginContributionController {
  readonly api: TextEditorPluginApi;
  close(): void;
  commit(): void;
}

interface StageRunCompleted<State> {
  readonly kind: "completed";
  readonly state: State;
}

type StageRunOutcome<State> =
  | StageRunCompleted<State>
  | {
      readonly kind: "failed";
      readonly failure: TextEditPipelineFailure;
    };

export interface TextMutationResult<Result> {
  readonly text: string;
  readonly result: Result;
}

export interface TextResourceEditFailure {
  readonly code:
    | "INVALID_REQUEST"
    | "INVALID_RESOLVER_RESULT"
    | "INVALID_RESOURCE_CONTENT"
    | "INVALID_WRITE_CONTENT"
    | "PLUGIN_FAILED"
    | "MUTATION_REJECTED"
    | "NO_RESOLVER"
    | "POST_WRITE_FAILED"
    | "READ_FAILED"
    | "RESOLVE_FAILED"
    | "UNSUPPORTED_CAPABILITY"
    | "UNSUPPORTED_CONTENT"
    | "WRITE_FAILED";
  readonly source: string;
  readonly resolverId?: string;
  readonly message: string;
  readonly cause?: unknown;
  /** Failed restoration and prior absence prevent a confirmed unchanged-resource claim. */
  readonly rollback?: {
    readonly failed: readonly string[];
    readonly originallyMissing: readonly string[];
  };
}

export type TextResourceEditOutcome<Result> =
  | {
      readonly kind: "completed";
      readonly source: string;
      readonly resolvedBy: string;
      readonly before: TextDocument;
      readonly after: TextDocument;
      readonly result: Result;
      readonly postEditContributions: readonly TextPostEditContribution[];
    }
  | { readonly kind: "failed"; readonly failure: TextResourceEditFailure };

export interface TextResourceEditRequest {
  /** Reject a resource created or removed since its batch snapshot was captured. */
  readonly expectedExistence?: boolean;
  readonly source: string;
  readonly read: boolean;
  readonly allowReadFailure?: boolean;
  /** Allow an anchored semantic action to use a read-only resource. */
  readonly requireWrite?: boolean;
}

export interface TextResourcesMutationResult<Result> {
  readonly changes: ReadonlyMap<string, readonly TextChange[]>;
  readonly result: Result;
  /** Complete without document writes, mutation guards, post-edit work, or edit completions. */
  readonly resourceEffect?: boolean;
}

export type TextResourcesEditOutcome<Result> =
  | {
      readonly kind: "completed";
      readonly resources: readonly Exclude<
        TextResourceEditOutcome<unknown>,
        { readonly kind: "failed" }
      >[];
      readonly result: Result;
    }
  | {
      readonly kind: "failed";
      readonly failure: TextResourceEditFailure;
      readonly completed: readonly string[];
    };

export type ResolveTextAnchor = (value: string, kinds?: readonly string[]) => Promise<TextAnchor>;

export type ResolveResourceTextAnchor = (
  source: string,
  value: string,
  kinds?: readonly string[],
) => Promise<TextAnchor>;

/** Input for resolving an anchor value against already-available text content. */
export interface TextAnchorInTextRequest {
  readonly source: string;
  readonly content: string;
  readonly value: string;
  readonly cwd: string;
  /** Limit resolution to these registered anchor kinds. Omit to use all configured resolvers. */
  readonly kinds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface TextResourcesEditContext
  extends ResourceResolverContext, TextMutationGuardContext {}

export interface TextEditorCore {
  /** Finalize a surviving local text file after a whole-file operation; binary files are untouched. */
  postProcessFile(source: string, context: ResourceResolverContext): Promise<void>;
  /** Reserve complete file sets. Only an explicit transaction owner may enqueue covered nested edits. */
  enqueueFileOperation<T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
    scope?: {
      readonly sources: readonly string[];
      readonly cwd: string;
      readonly allowNestedEdits?: boolean;
    },
  ): Promise<T>;
  inspectTextAnchors(request: TextAnchorInspectionRequest): Promise<TextAnchorInspectionOutcome>;
  addAnchorResolver(registration: TextAnchorResolverRegistration): void;
  resolveTextAnchorResources(
    value: string,
    kinds: readonly string[],
    context: TextAnchorResourceResolverContext,
  ): Promise<readonly TextTarget[] | undefined>;
  textTargetResolver(): TextTargetResolver;
  /** Resolves one anchor value against provided text content without reading resources. */
  resolveAnchorInText(request: TextAnchorInTextRequest): Promise<TextAnchor>;
  editText<Result>(
    source: string,
    context: ResourceResolverContext,
    operation: (
      text: string,
      resolveAnchor: ResolveTextAnchor,
    ) => TextMutationResult<Result> | Promise<TextMutationResult<Result>>,
  ): Promise<TextResourceEditOutcome<Result>>;
  editTexts<Result>(
    sources: readonly TextResourceEditRequest[],
    context: TextResourcesEditContext,
    operation: (
      texts: ReadonlyMap<string, string>,
      resolveAnchor: ResolveResourceTextAnchor,
    ) => TextResourcesMutationResult<Result> | Promise<TextResourcesMutationResult<Result>>,
  ): Promise<TextResourcesEditOutcome<Result>>;
  previewTexts(
    sources: readonly TextResourceEditRequest[],
    context: ResourceResolverContext,
    operation: (
      texts: ReadonlyMap<string, string>,
      resolveAnchor: ResolveResourceTextAnchor,
    ) => TextResourcesMutationResult<unknown> | Promise<TextResourcesMutationResult<unknown>>,
  ): Promise<TextMutationPreviewOutcome>;
  getSemanticMutationHandler(
    tool: TextEditorToolId,
    input: unknown,
  ): TextSemanticMutationHandler | undefined;
  executeEdit<Input, Result>(
    tool: TextEditorToolId,
    initialState: TextPreEditState<Input>,
    operation: (state: TextPreEditState<Input>) => Result | Promise<Result>,
  ): Promise<TextEditExecutionOutcome<Input, Result>>;
  addMutationTool(registration: AnyTextMutationToolRegistration): void;
  getMutationTools(): readonly AnyTextMutationToolRegistration[];
  onMutationTool(listener: TextMutationToolListener): () => void;
  onDidEdit(listener: TextEditCompletionListener): () => void;
  getToolRenderer(tool: TextEditorToolId): TextEditorToolRendererRegistration | undefined;
  registerPlugin(plugin: TextEditorPlugin): Promise<void>;
  registerPostEditHandler(registration: TextPostEditHandlerRegistration): () => void;
  registerTool(tool: TextEditorToolId): void;
  waitForPendingPlugins(): Promise<void>;
  renderGeneralPromptGuideline(kinds?: ReadonlySet<string>): string | undefined;
  /** Returns the configured number of lines around recovery candidates. */
  recoveryContextLines(): number;
  renderToolPromptGuideline(tool: TextEditorToolId): string | undefined;
}

export function createTextEditorCore(
  registerMutationTool?: (
    registration: AnyTextMutationToolRegistration,
    core: TextEditorCore,
  ) => void,
): TextEditorCore {
  const projectConfig = loadTextEditorConfig(process.cwd());
  const resolvers: RegisteredResolver[] = [];
  const anchorRegistry = new TextAnchorRegistry();
  const handlers: RegisteredHandler[] = [];
  const semanticHandlers: RegisteredSemanticHandler[] = [];
  const presenters: RegisteredPresenter[] = [];
  const postEditHandlers = new Map<string, TextPostEditHandlerRegistration>();
  const pendingPlugins = new Set<Promise<void>>();
  const plugins = new Map<string, RegisteredPlugin>();
  const promptContributions: PromptContribution[] = [];
  const writablePromptContributions: WritablePromptContribution[] = [];
  const registeredTools = new Set<TextEditorToolId>();
  const mutationTools = new Map<string, AnyTextMutationToolRegistration>();
  const mutationListeners = new Set<TextMutationToolListener>();
  const editCompletionListeners = new Set<TextEditCompletionListener>();
  const mutationGuards: TextMutationGuardRegistration[] = [];
  const toolRenderers = new Map<TextEditorToolId, TextEditorToolRendererRegistration>();
  let registrationQueue = Promise.resolve();
  const scheduler = resourceScheduler;
  const enqueueMutation = <T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
    accesses?: Promise<readonly ResourceAccess[] | undefined>,
  ): Promise<T> => scheduler.run(accesses, action, signal);
  const registerContributions = (draft: PluginContributionDraft): void => {
    validateContributionDraft(
      draft,
      resolvers,
      handlers,
      semanticHandlers,
      promptContributions,
      writablePromptContributions,
    );

    const incomingMutationNames = new Set<string>();

    for (const registration of draft.mutationTools ?? []) {
      assertTextMutationToolRegistration(registration);

      if (mutationTools.has(registration.name) || incomingMutationNames.has(registration.name)) {
        throw new Error(`Mutation tool ${registration.name} is already registered`);
      }

      incomingMutationNames.add(registration.name);
    }

    for (const registration of draft.toolRenderers ?? []) {
      if (!isTextEditorToolRendererRegistration(registration)) {
        throw new TypeError("Plugin provided an invalid text editor tool renderer");
      }
    }

    anchorRegistry.assertCanAdd(draft.anchorResolvers.map(({ registration }) => registration));
    const incomingPresenters = draft.presenters ?? [];
    const presenterIds = new Set(presenters.map(({ registration }) => registration.presenter.id));

    for (const contribution of incomingPresenters) {
      if (!isTextPresenterRegistration(contribution.registration)) {
        throw new TypeError(`Plugin ${contribution.pluginId} provided an invalid text presenter`);
      }

      if (presenterIds.has(contribution.registration.presenter.id)) {
        throw new Error(
          `Text presenter ${contribution.registration.presenter.id} is already registered`,
        );
      }

      presenterIds.add(contribution.registration.presenter.id);
    }

    for (const contribution of draft.resolvers) {
      resolvers.push({
        resolver: contribution.registration.resolver,
        priority: contribution.registration.priority ?? 0,
        order: resolvers.length,
      });
    }

    for (const contribution of draft.anchorResolvers) {
      anchorRegistry.add(contribution.registration);
    }

    for (const contribution of incomingPresenters) {
      presenters.push({ ...contribution, order: presenters.length });
    }

    handlers.push(...draft.handlers);
    semanticHandlers.push(...(draft.semanticHandlers ?? []));
    mutationGuards.push(...(draft.mutationGuards ?? []));
    promptContributions.push(...draft.promptContributions);
    writablePromptContributions.push(...draft.writablePromptContributions);

    for (const registration of draft.toolRenderers ?? []) {
      const current = toolRenderers.get(registration.tool);
      toolRenderers.set(registration.tool, mergeToolRenderer(current, registration));
    }

    for (const tool of draft.tools) {
      registeredTools.add(tool);
    }

    for (const registration of draft.mutationTools ?? []) {
      addMutationRegistration(
        registration,
        mutationTools,
        registeredTools,
        mutationListeners,
        registerMutationTool,
        core,
      );
    }

    for (const listener of draft.mutationToolListeners ?? []) {
      replayMutationTools(listener, mutationTools);
      mutationListeners.add(listener);
    }

    for (const listener of draft.editCompletionListeners ?? []) {
      editCompletionListeners.add(listener);
    }
  };

  const core: TextEditorCore = {
    async postProcessFile(source, context) {
      await enqueueMutation(
        async () => {
          const file = path.resolve(context.cwd, source);
          const stat = await lstat(file).catch(() => undefined);
          if (!stat?.isFile() || stat.isSymbolicLink()) return;
          const bytes = await readFile(file);
          const text = bytes.toString("utf8");
          if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) return;
          await finalizeTextResource({
            requestedSource: file,
            outcomeSource: file,
            resource: {
              source: file,
              async read() {
                return [{ type: "text", text: await readFile(file, "utf8") }];
              },
            },
            resolvedBy: "filesystem",
            existed: true,
            before: createTextDocument(file, text),
            requestedText: text,
            context,
            presenters: [...presenters],
            postEditHandlers: [...postEditHandlers.values()],
            editCompletionListeners: [...editCompletionListeners],
            result: undefined,
          });
        },
        context.signal,
        resourceAccesses(source, context.cwd, "write"),
      );
    },
    enqueueFileOperation(action, signal, scope) {
      const accesses =
        scope === undefined
          ? undefined
          : Promise.all(
              scope.sources.map((source) => resourceAccesses(source, scope.cwd, "write")),
            ).then((sets) => sets.flat());
      return scheduler.run(accesses, action, signal, {
        allowNestedWrites: scope?.allowNestedEdits === true,
      });
    },
    addAnchorResolver(registration): void {
      if (!isTextAnchorResolverRegistration(registration)) {
        throw new TypeError("Invalid text anchor resolver");
      }

      anchorRegistry.add(registration);
    },
    addMutationTool(registration): void {
      addMutationRegistration(
        registration,
        mutationTools,
        registeredTools,
        mutationListeners,
        registerMutationTool,
        core,
      );
    },
    getMutationTools(): readonly AnyTextMutationToolRegistration[] {
      return [...mutationTools.values()];
    },
    onMutationTool(listener): () => void {
      replayMutationTools(listener, mutationTools);
      mutationListeners.add(listener);
      return () => mutationListeners.delete(listener);
    },
    onDidEdit(listener): () => void {
      editCompletionListeners.add(listener);
      return () => editCompletionListeners.delete(listener);
    },
    getSemanticMutationHandler(tool, input): TextSemanticMutationHandler | undefined {
      const matches = semanticHandlers.filter(
        (registered) => registered.tool === tool && registered.handler.matches(input),
      );
      if (matches.length > 1) {
        throw new Error(`More than one semantic handler accepted ${tool}`);
      }
      return matches[0]?.handler;
    },
    getToolRenderer(tool): TextEditorToolRendererRegistration | undefined {
      return toolRenderers.get(tool);
    },
    inspectTextAnchors(request): Promise<TextAnchorInspectionOutcome> {
      return inspectTextResource(request, [...resolvers], anchorRegistry.snapshot());
    },
    resolveTextAnchorResources(value, kinds, context): Promise<readonly TextTarget[] | undefined> {
      return anchorRegistry.snapshot().resolveResources(value, context, new Set(kinds));
    },
    textTargetResolver(): TextTargetResolver {
      return {
        id: "text-editor-anchors",
        tryResolve: async (value, context) => {
          const targets = await anchorRegistry.snapshot().resolveResources(value, context);
          return targets === undefined ? { kind: "not-handled" } : { kind: "resolved", targets };
        },
      };
    },
    resolveAnchorInText(request: TextAnchorInTextRequest): Promise<TextAnchor> {
      const context: TextAnchorResolverContext = {
        source: request.source,
        content: request.content,
        lines: request.content.length === 0 ? [] : request.content.split(/\r?\n/u),
        cwd: request.cwd,
        ...(request.signal !== undefined && { signal: request.signal }),
      };

      return anchorRegistry
        .snapshot()
        .resolve(
          request.value,
          context,
          request.kinds === undefined ? undefined : new Set(request.kinds),
        );
    },
    editText<Result>(
      source: string,
      context: ResourceResolverContext,
      operation: (
        text: string,
        resolveAnchor: ResolveTextAnchor,
      ) => TextMutationResult<Result> | Promise<TextMutationResult<Result>>,
    ): Promise<TextResourceEditOutcome<Result>> {
      const resolverSnapshot = [...resolvers].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      );
      const presenterSnapshot = [...presenters].sort(
        (left, right) =>
          (left.registration.priority ?? 0) - (right.registration.priority ?? 0) ||
          left.order - right.order,
      );
      const scoped = scopedResolvers([source], context, resolverSnapshot);
      return enqueueMutation(
        () =>
          editTextResource(
            source,
            context,
            scoped.resolvers,
            anchorRegistry.snapshot(),
            presenterSnapshot,
            [...postEditHandlers.values()],
            [...editCompletionListeners],
            operation,
          ),
        context.signal,
        scoped.accesses,
      );
    },
    editTexts<Result>(
      sources: readonly TextResourceEditRequest[],
      context: TextResourcesEditContext,
      operation: (
        texts: ReadonlyMap<string, string>,
        resolveAnchor: ResolveResourceTextAnchor,
      ) => TextResourcesMutationResult<Result> | Promise<TextResourcesMutationResult<Result>>,
    ): Promise<TextResourcesEditOutcome<Result>> {
      const resolverSnapshot = [...resolvers].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      );
      const presenterSnapshot = [...presenters].sort(
        (left, right) =>
          (left.registration.priority ?? 0) - (right.registration.priority ?? 0) ||
          left.order - right.order,
      );
      const scoped = scopedResolvers(
        sources.map((request) => request.source),
        context,
        resolverSnapshot,
      );
      return enqueueMutation(
        () =>
          editTextResources(
            sources,
            context,
            scoped.resolvers,
            anchorRegistry.snapshot(),
            presenterSnapshot,
            [...postEditHandlers.values()],
            [...editCompletionListeners],
            [...mutationGuards],
            operation,
          ),
        context.signal,
        scoped.accesses,
      );
    },
    previewTexts(sources, context, operation): Promise<TextMutationPreviewOutcome> {
      const resolverSnapshot = [...resolvers].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      );
      const scoped = scopedResolvers(
        sources.map((request) => request.source),
        context,
        resolverSnapshot,
        "read",
      );
      return scheduler.run(
        scoped.accesses,
        () =>
          previewTextResources(
            sources,
            context,
            scoped.resolvers,
            anchorRegistry.snapshot(),
            operation,
          ),
        context.signal,
      );
    },
    async executeEdit<Input, Result>(
      tool: TextEditorToolId,
      initialState: TextPreEditState<Input>,
      operation: (state: TextPreEditState<Input>) => Result | Promise<Result>,
    ): Promise<TextEditExecutionOutcome<Input, Result>> {
      if (!isTextEditorToolId(tool)) {
        throw new Error(`Unsupported text editor tool ${String(tool)}`);
      }

      const invocationHandlers = handlers.filter((registered) => registered.tool === tool);
      const preEdit = await runPreEditHandlers(initialState, invocationHandlers, tool);

      if (preEdit.kind === "failed") {
        return preEdit;
      }

      const result = await operation(preEdit.state);
      const editState: TextEditState<Input, Result> = {
        ...preEdit.state,
        result,
      };
      const edit = await runResultHandlers("text-edit", editState, invocationHandlers, tool);

      if (edit.kind === "failed") {
        return edit;
      }

      const postEdit = await runResultHandlers(
        "text-post-edit",
        edit.state,
        invocationHandlers,
        tool,
      );

      if (postEdit.kind === "failed") {
        return postEdit;
      }

      return { kind: "completed", state: postEdit.state };
    },
    registerPostEditHandler(registration): () => void {
      if (!isTextPostEditHandlerRegistration(registration)) {
        throw new TypeError("Invalid text editor post-edit handler registration");
      }

      if (postEditHandlers.has(registration.id)) {
        throw new Error(`Post-edit handler ${registration.id} is already registered`);
      }

      postEditHandlers.set(registration.id, registration);
      return () => {
        if (postEditHandlers.get(registration.id) === registration) {
          postEditHandlers.delete(registration.id);
        }
      };
    },
    registerTool(tool): void {
      if (!isTextEditorToolId(tool)) {
        throw new TypeError("Invalid text editor tool ID");
      }

      registeredTools.add(tool);
    },
    registerPlugin(plugin): Promise<void> {
      const validationError = getPluginValidationError(plugin);

      if (validationError !== undefined) {
        return Promise.reject(validationError);
      }

      const existing = plugins.get(plugin.id);

      if (existing?.plugin === plugin) {
        return existing.ready;
      }

      if (existing !== undefined) {
        return Promise.reject(new Error(`Plugin ${plugin.id} is already registered`));
      }

      const lifecycle: PluginLifecycle = { status: "pending" };
      const contributions = createPluginContributionController(
        plugin.id,
        registerContributions,
        (request) => inspectTextResource(request, [...resolvers], anchorRegistry.snapshot()),
        (listener) => core.onMutationTool(listener),
        (listener) => core.onDidEdit(listener),
        (request) => previewTextMutation(core, request),
        (section) => recoverySection(projectConfig, section),
      );
      const ready = registrationQueue.then(async () => {
        try {
          await plugin.setup(contributions.api);
          contributions.commit();
          lifecycle.status = "active";
          return;
        } catch (error) {
          contributions.close();
          throw error;
        }
      });
      const registeredPlugin: RegisteredPlugin = { lifecycle, plugin, ready };

      plugins.set(plugin.id, registeredPlugin);
      pendingPlugins.add(ready);
      registrationQueue = ready.catch(() => {});
      void ready.then(
        () => {
          pendingPlugins.delete(ready);
          return;
        },
        () => {
          pendingPlugins.delete(ready);

          if (plugins.get(plugin.id) === registeredPlugin) {
            plugins.delete(plugin.id);
          }

          return;
        },
      );

      return ready;
    },
    recoveryContextLines(): number {
      return projectConfig.contextLines;
    },
    renderGeneralPromptGuideline(kinds?: ReadonlySet<string>): string | undefined {
      const sections: string[] = [];
      const writableEntries: string[] = [];

      for (const registeredPlugin of plugins.values()) {
        if (registeredPlugin.lifecycle.status !== "active") {
          continue;
        }

        const contribution = writablePromptContributions.find(
          (candidate) => candidate.pluginId === registeredPlugin.plugin.id,
        );

        if (contribution === undefined) {
          continue;
        }

        const description = renderDescriptionSource(contribution.description);

        if (description !== undefined) {
          writableEntries.push(renderPromptEntry(registeredPlugin.plugin.id, description));
        }
      }

      if (writableEntries.length > 0) {
        sections.push(
          ["Text edits support these writable resources:", ...writableEntries].join("\n"),
        );
      }

      const anchorSection = anchorRegistry.renderPromptSection(kinds);

      if (anchorSection !== undefined) {
        sections.push(anchorSection);
      }

      return sections.length === 0 ? undefined : indentGuidelineContinuation(sections.join("\n\n"));
    },
    renderToolPromptGuideline(tool): string | undefined {
      const entries: string[] = [];

      for (const registeredPlugin of plugins.values()) {
        if (registeredPlugin.lifecycle.status !== "active") {
          continue;
        }

        const contribution = promptContributions.find(
          (candidate) =>
            candidate.pluginId === registeredPlugin.plugin.id && candidate.tool === tool,
        );

        if (contribution !== undefined) {
          entries.push(contribution.description);
        }
      }

      return entries.length === 0 ? undefined : entries.join("\n");
    },
    async waitForPendingPlugins(): Promise<void> {
      await Promise.all(pendingPlugins);
    },
  };

  return core;
}

async function inspectTextResource(
  request: TextAnchorInspectionRequest,
  resolvers: readonly RegisteredResolver[],
  anchors: TextAnchorRegistrySnapshot,
): Promise<TextAnchorInspectionOutcome> {
  const context: ResourceResolverContext = {
    cwd: request.cwd,
    ...(request.signal !== undefined && { signal: request.signal }),
  };

  for (const { resolver } of [...resolvers].sort(
    (left, right) => left.priority - right.priority || left.order - right.order,
  )) {
    let attempt: unknown;

    try {
      attempt = await resolver.tryResolve(request.source, context);
    } catch (error) {
      return { kind: "failed", reason: `Resolver ${resolver.id} failed`, cause: error };
    }

    if (!isResourceResolutionAttempt(attempt)) {
      return {
        kind: "failed",
        reason: `Resolver ${resolver.id} returned an invalid result`,
        cause: attempt,
      };
    }

    if (attempt.kind === "not-handled") {
      continue;
    }

    if (attempt.kind === "failed") {
      return { kind: "failed", reason: `Resolver ${resolver.id} failed`, cause: attempt.error };
    }

    const { resource } = attempt;

    if (resource.read === undefined) {
      return { kind: "failed", reason: `Resource ${resource.source} is not readable text` };
    }

    let content: unknown;

    try {
      content = await resource.read(request.signal === undefined ? {} : { signal: request.signal });
    } catch (error) {
      return { kind: "failed", reason: `Unable to read ${resource.source}`, cause: error };
    }

    if (!isAgentContent(content) || content.length !== 1 || content[0].type !== "text") {
      return {
        kind: "failed",
        reason: `Resource ${resource.source} is not readable text`,
        cause: content,
      };
    }

    return anchors.inspect(request.anchors, request.kinds, {
      source: resource.source,
      content: content[0].text,
      lines: content[0].text.length === 0 ? [] : content[0].text.split(/\r?\n/u),
      cwd: request.cwd,
      ...(request.signal !== undefined && { signal: request.signal }),
    });
  }

  return { kind: "failed", reason: `No resolver handled ${request.source}` };
}

async function previewTextResources(
  requests: readonly TextResourceEditRequest[],
  context: ResourceResolverContext,
  resolvers: readonly RegisteredResolver[],
  anchorResolvers: TextAnchorRegistrySnapshot,
  operation: (
    texts: ReadonlyMap<string, string>,
    resolveAnchor: ResolveResourceTextAnchor,
  ) => TextResourcesMutationResult<unknown> | Promise<TextResourcesMutationResult<unknown>>,
): Promise<TextMutationPreviewOutcome> {
  try {
    const requestBySource = new Map(requests.map((request) => [request.source, request]));
    const sources = [...requestBySource.keys()];

    if (sources.length === 0 || sources.some((source) => source.length === 0)) {
      return { kind: "failed", reason: "No source was provided" };
    }

    const prepared = new Map<string, PreparedTextResource>();

    for (const source of sources) {
      const request = requiredValue(requestBySource.get(source));
      const outcome = await prepareTextResource(
        source,
        request.read,
        request.allowReadFailure ?? false,
        request.requireWrite ?? true,
        context,
        resolvers,
      );

      if ("failure" in outcome) {
        return { kind: "failed", reason: outcome.failure.message };
      }

      if (
        request.expectedExistence !== undefined &&
        request.expectedExistence !== outcome.existed
      ) {
        throw new Error(`Snapshot source ${source} was created or removed before the edit batch.`);
      }
      prepared.set(source, outcome);
    }

    const texts = new Map([...prepared].map(([source, item]) => [source, item.before.content]));
    const mutation = await operation(texts, (source, value, kinds) => {
      const item = prepared.get(source);

      if (item === undefined) {
        throw new Error(`Anchor refers to undeclared resource ${source}`);
      }

      return anchorResolvers.resolve(
        value,
        item.anchorContext,
        kinds === undefined ? undefined : new Set(kinds),
      );
    });
    const resources = sources.map((source) => {
      const item = requiredValue(prepared.get(source));
      const changes = mutation.changes.get(source);
      const applied =
        changes === undefined
          ? { content: item.before.content, changes: [] }
          : applyTextChanges(item.before.content, changes, !item.existed);
      return {
        path: source,
        existed: item.existed,
        beforeRanges: applied.changes.map(({ fromBefore: from, toBefore: to }) => ({ from, to })),
        resolvedBy: item.resolverId,
        ...(item.resource.link !== undefined && { link: item.resource.link }),
        beforeContent: item.before.content,
        afterContent: applied.content,
        ranges: applied.changes.map(({ fromAfter: from, toAfter: to }) => ({ from, to })),
      };
    });

    return { kind: "completed", resources };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

interface PreparedTextResource {
  readonly requestedSource: string;
  readonly resource: Resource;
  readonly resolverId: string;
  readonly existed: boolean;
  readonly before: TextDocument;
  readonly anchorContext: TextAnchorResolverContext;
}

async function editTextResources<Result>(
  requests: readonly TextResourceEditRequest[],
  context: TextResourcesEditContext,
  resolvers: readonly RegisteredResolver[],
  anchorResolvers: TextAnchorRegistrySnapshot,
  presenters: readonly RegisteredPresenter[],
  postEditHandlers: readonly TextPostEditHandlerRegistration[],
  editCompletionListeners: readonly TextEditCompletionListener[],
  mutationGuards: readonly TextMutationGuardRegistration[],
  operation: (
    texts: ReadonlyMap<string, string>,
    resolveAnchor: ResolveResourceTextAnchor,
  ) => TextResourcesMutationResult<Result> | Promise<TextResourcesMutationResult<Result>>,
): Promise<TextResourcesEditOutcome<Result>> {
  const requestBySource = new Map(requests.map((request) => [request.source, request]));
  const sources = [...requestBySource.keys()];

  if (sources.length === 0 || sources.some((source) => source.length === 0)) {
    const source = sources.find((candidate) => candidate.length === 0) ?? "";
    return {
      kind: "failed",
      failure: { code: "INVALID_REQUEST", source, message: "No source was provided" },
      completed: [],
    };
  }

  const prepared = new Map<string, PreparedTextResource>();

  // Settle every read before releasing the transaction's resource reservations.
  const reads = await Promise.allSettled(
    sources.map((source) => {
      const request = requiredValue(requestBySource.get(source));
      return prepareTextResource(
        source,
        request.read,
        request.allowReadFailure ?? false,
        request.requireWrite ?? true,
        context,
        resolvers,
      );
    }),
  );
  for (const [index, read] of reads.entries()) {
    if (read.status === "rejected") throw read.reason;
    const source = requiredValue(sources[index]);
    const request = requiredValue(requestBySource.get(source));
    const outcome = read.value;
    if ("failure" in outcome) {
      return { kind: "failed", failure: outcome.failure, completed: [] };
    }
    if (request.expectedExistence !== undefined && request.expectedExistence !== outcome.existed) {
      throw new Error(`Snapshot source ${source} was created or removed before the edit batch.`);
    }
    prepared.set(source, outcome);
  }

  const texts = new Map([...prepared].map(([source, item]) => [source, item.before.content]));
  const mutation = await operation(texts, (source, value, kinds) => {
    const item = prepared.get(source);

    if (item === undefined) {
      throw new Error(`Anchor refers to undeclared resource ${source}`);
    }

    return anchorResolvers.resolve(
      value,
      item.anchorContext,
      kinds === undefined ? undefined : new Set(kinds),
    );
  });

  if (mutation.resourceEffect === true) {
    if (mutation.changes.size !== 0) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_WRITE_CONTENT",
          source: sources[0] ?? "",
          message: "A resource effect cannot also contain document changes",
        },
        completed: [],
      };
    }
    return { kind: "completed", resources: [], result: mutation.result };
  }
  for (const source of mutation.changes.keys()) {
    if (!prepared.has(source)) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_WRITE_CONTENT",
          source,
          message: `Text edit produced an undeclared resource ${source}`,
        },
        completed: [],
      };
    }
  }

  if (mutation.changes.size > 1) {
    const identities = await Promise.all(
      [...mutation.changes.keys()].map(async (source) => ({
        source,
        accesses: await resourceAccesses(
          requiredValue(prepared.get(source)).resource.source,
          context.cwd,
          "write",
        ),
      })),
    );
    const owners = new Map<string, string>();
    for (const { source, accesses } of identities) {
      for (const { resource } of accesses) {
        const owner = owners.get(resource);
        if (owner !== undefined && owner !== source) {
          return {
            kind: "failed",
            failure: {
              code: "MUTATION_REJECTED",
              source,
              message: `Sources ${owner} and ${source} alias the same resource; use one source name for its edits.`,
            },
            completed: [],
          };
        }
        owners.set(resource, source);
      }
    }
  }
  const applied = new Map<string, TextChangeResult>();

  for (const [source, changes] of mutation.changes) {
    const item = requiredValue(prepared.get(source));
    applied.set(source, applyTextChanges(item.before.content, changes, !item.existed));
  }

  const plan: TextMutationPlan = {
    resources: sources.flatMap((source) => {
      const item = requiredValue(prepared.get(source));
      const result = applied.get(source);

      return result === undefined || (item.existed && result.content === item.before.content)
        ? []
        : [
            {
              source: item.resource.source,
              existed: item.existed,
              before: item.before,
              after: createTextDocument(item.resource.source, result.content),
              changes: result.changes,
            },
          ];
    }),
  };

  for (const registration of mutationGuards) {
    let outcome;

    try {
      outcome = await registration.guard(plan, context);
    } catch (error) {
      return {
        kind: "failed",
        failure: {
          code: "PLUGIN_FAILED",
          source: sources[0] ?? "",
          message: `Mutation guard ${registration.id} failed`,
          cause: error,
        },
        completed: [],
      };
    }

    if (outcome.kind === "rejected") {
      return {
        kind: "failed",
        failure: {
          code: "MUTATION_REJECTED",
          source: plan.resources[0]?.source ?? sources[0] ?? "",
          message: outcome.rejection.message,
        },
        completed: [],
      };
    }
  }

  // A guard may finish after cancellation; reject before the first write.
  context.signal?.throwIfAborted();
  const written = sources.filter((source) => {
    const text = applied.get(source)?.content;
    const item = requiredValue(prepared.get(source));
    return text !== undefined && (!item.existed || text !== item.before.content);
  });
  const writes = await Promise.allSettled(
    written.map(async (source) => {
      const item = requiredValue(prepared.get(source));
      const text = requiredValue(applied.get(source)).content;
      await requiredValue(item.resource.write)(
        [{ type: "text", text }],
        context.signal === undefined ? {} : { signal: context.signal },
      );
    }),
  );
  const failedIndex = writes.findIndex((result) => result.status === "rejected");
  if (failedIndex !== -1) {
    const source = requiredValue(written[failedIndex]);
    const item = requiredValue(prepared.get(source));
    const failure = requiredValue(writes[failedIndex]);
    const rollbackFailures: string[] = [];
    // All attempts have settled; even a rejected write may have changed its resource.
    for (const writtenSource of [...written].reverse()) {
      const writtenItem = requiredValue(prepared.get(writtenSource));
      try {
        await requiredValue(writtenItem.resource.write)(
          [{ type: "text", text: writtenItem.before.content }],
          {},
        );
      } catch {
        rollbackFailures.push(writtenSource);
      }
    }
    const originallyMissing = written.filter(
      (writtenSource) => !requiredValue(prepared.get(writtenSource)).existed,
    );
    const rollbackReason =
      rollbackFailures.length === 0 ? "" : `; rollback failed for ${rollbackFailures.join(", ")}`;
    const missingReason =
      originallyMissing.length === 0
        ? ""
        : `; restoring text did not confirm the original missing-file state for ${originallyMissing.join(", ")}`;
    return {
      kind: "failed",
      failure: {
        code: "WRITE_FAILED",
        source,
        resolverId: item.resolverId,
        message: `Unable to write ${source}${rollbackReason}${missingReason}`,
        cause: failure.status === "rejected" ? failure.reason : undefined,
        rollback: { failed: rollbackFailures, originallyMissing },
      },
      completed: [],
    };
  }
  const outcomes: Exclude<TextResourceEditOutcome<unknown>, { readonly kind: "failed" }>[] = [];

  let finalizingSource = written[0] ?? sources[0] ?? "";
  try {
    await collectPostEditNotifications(async () => {
      for (const source of written) {
        finalizingSource = source;
        const text = requiredValue(applied.get(source)).content;
        const item = requiredValue(prepared.get(source));
        outcomes.push(
          await finalizeTextResource({
            requestedSource: item.requestedSource,
            outcomeSource: item.requestedSource,
            resource: item.resource,
            resolvedBy: item.resolverId,
            existed: item.existed,
            before: item.before,
            requestedText: text,
            context,
            presenters,
            postEditHandlers,
            editCompletionListeners,
            result: mutation.result,
          }),
        );
      }
    });
  } catch (error) {
    return {
      kind: "failed",
      failure: {
        code: "POST_WRITE_FAILED",
        source: finalizingSource,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      },
      completed: written,
    };
  }
  return { kind: "completed", resources: outcomes, result: mutation.result };
}

async function prepareTextResource(
  source: string,
  read: boolean,
  allowReadFailure: boolean,
  requireWrite: boolean,
  context: ResourceResolverContext,
  resolvers: readonly RegisteredResolver[],
): Promise<PreparedTextResource | { readonly failure: TextResourceEditFailure }> {
  for (const { resolver } of resolvers) {
    let attempt: unknown;

    try {
      attempt = await resolver.tryResolve(source, context);
    } catch (error) {
      return {
        failure: {
          code: "RESOLVE_FAILED",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} failed`,
          cause: error,
        },
      };
    }

    if (!isResourceResolutionAttempt(attempt)) {
      return {
        failure: {
          code: "INVALID_RESOLVER_RESULT",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} returned an invalid result`,
          cause: attempt,
        },
      };
    }

    if (attempt.kind === "not-handled") {
      continue;
    }

    if (attempt.kind === "failed") {
      return {
        failure: {
          code: "RESOLVE_FAILED",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} failed`,
          cause: attempt.error,
        },
      };
    }

    if (
      (requireWrite && attempt.resource.write === undefined) ||
      (read && attempt.resource.read === undefined)
    ) {
      return {
        failure: {
          code: "UNSUPPORTED_CAPABILITY",
          source: attempt.resource.source,
          resolverId: resolver.id,
          message: `Resource ${attempt.resource.source} does not support text editing`,
        },
      };
    }

    let text = "";
    let isExisted = read;

    if (read) {
      let content: unknown;

      try {
        content = await requiredValue(attempt.resource.read)(
          context.signal === undefined ? {} : { signal: context.signal },
        );
      } catch (error) {
        if (!allowReadFailure) {
          return {
            failure: {
              code: "READ_FAILED",
              source: attempt.resource.source,
              resolverId: resolver.id,
              message: `Unable to read ${attempt.resource.source}`,
              cause: error,
            },
          };
        }

        isExisted = false;
        content = [{ type: "text", text: "" }];
      }

      if (!isAgentContent(content) || content.length !== 1 || content[0].type !== "text") {
        return {
          failure: {
            code: "UNSUPPORTED_CONTENT",
            source: attempt.resource.source,
            resolverId: resolver.id,
            message: `Resource ${attempt.resource.source} is not editable text`,
            cause: content,
          },
        };
      }

      text = content[0].text;
    }

    const before = createTextDocument(attempt.resource.source, text);
    return {
      requestedSource: source,
      resource: attempt.resource,
      resolverId: resolver.id,
      existed: isExisted,
      before,
      anchorContext: {
        source: attempt.resource.source,
        content: before.content,
        lines: before.lines.map((line) => line.content),
        cwd: context.cwd,
        ...(context.signal !== undefined && { signal: context.signal }),
      },
    };
  }

  return { failure: { code: "NO_RESOLVER", source, message: `No resolver handled ${source}` } };
}

interface FinalizeTextResourceRequest<Result> {
  readonly postProcessingFinal?: boolean;
  readonly requestedSource: string;
  readonly outcomeSource: string;
  readonly resource: Resource;
  readonly resolvedBy: string;
  readonly existed: boolean;
  readonly before: TextDocument;
  readonly requestedText: string;
  readonly context: ResourceResolverContext & { readonly intent?: TextEditIntent };
  readonly presenters: readonly RegisteredPresenter[];
  readonly postEditHandlers: readonly TextPostEditHandlerRegistration[];
  readonly editCompletionListeners: readonly TextEditCompletionListener[];
  readonly result: Result;
}

async function finalizeTextResource<Result>(
  request: FinalizeTextResourceRequest<Result>,
): Promise<Exclude<TextResourceEditOutcome<Result>, { readonly kind: "failed" }>> {
  const skipPostEdit = request.resource.skipPostEdit === true;
  if (
    !skipPostEdit &&
    request.postProcessingFinal &&
    !request.context.signal?.aborted &&
    request.resource.read
  ) {
    const current = await request.resource.read(
      request.context.signal ? { signal: request.context.signal } : {},
    );
    if (
      !isAgentContent(current) ||
      current.length !== 1 ||
      current[0].type !== "text" ||
      current[0].text !== request.requestedText
    )
      throw Object.assign(
        new Error(`Resource changed before final post-processing: ${request.resource.source}`),
        { code: "POST_EDIT_STALE" },
      );
  }
  const deferred =
    !skipPostEdit &&
    !request.postProcessingFinal &&
    deferPostEdit(request.resource.source, () =>
      finalizeTextResource({ ...request, postProcessingFinal: true }),
    );
  const requestedAfter = createTextDocument(request.resource.source, request.requestedText);
  const transaction: TextPostEditTransaction = {
    source: request.requestedSource,
    resourceSource: request.resource.source,
    resolvedBy: request.resolvedBy,
    cwd: request.context.cwd,
    before: request.before,
    requestedAfter,
    ...(request.context.signal !== undefined && { signal: request.context.signal }),
  };
  const postEditContributions: TextPostEditContribution[] = deferred
    ? [{ id: "post-edit-scope", data: { formatting: { status: "deferred" } } }]
    : [];

  for (const registration of skipPostEdit || deferred || request.context.signal?.aborted
    ? []
    : request.postEditHandlers) {
    try {
      const data = await registration.handler(transaction);

      if (data !== undefined) {
        postEditContributions.push({ id: registration.id, data });
      }
    } catch {
      // Post-edit integrations do not change a successful write into a failure.
    }
  }

  if (!skipPostEdit && !deferred && request.context.signal?.aborted)
    postEditContributions.push({
      id: "post-edit-interruption",
      data: {
        diffStatuses: [
          {
            text: "Post-edit processing was interrupted. Read the saved file before retrying.",
            tone: "warning",
          },
        ],
      },
    });
  let finalText = request.requestedText;

  if (!skipPostEdit && request.resource.read !== undefined) {
    try {
      const reread = await request.resource.read(
        request.context.signal === undefined ? {} : { signal: request.context.signal },
      );

      if (isAgentContent(reread) && reread.length === 1 && reread[0].type === "text") {
        finalText = reread[0].text;
      }
    } catch {
      // The requested mutation remains the successful fallback when a final reread fails.
    }
  }

  const finalAfter = createTextDocument(request.resource.source, finalText);
  const completion: TextEditCompletion = {
    source: request.requestedSource,
    resourceSource: request.resource.source,
    resolvedBy: request.resolvedBy,
    cwd: request.context.cwd,
    existed: request.existed,
    before: request.postProcessingFinal ? requestedAfter : request.before,
    after: finalAfter,
    intent: request.context.intent ?? "edit",
    postProcessing: deferred
      ? "deferred"
      : request.context.signal?.aborted
        ? "interrupted"
        : request.postProcessingFinal
          ? "final"
          : "complete",
  };

  for (const listener of request.editCompletionListeners) {
    try {
      const feedback = await listener(completion);
      if (feedback !== undefined && feedback.feedback.trim().length > 0) {
        postEditContributions.push({
          id: "after-edit",
          data: {
            diffStatuses: [
              {
                text: feedback.feedback,
                tone: feedback.tone === "info" ? "muted" : feedback.tone,
              },
            ],
          },
        });
      }
    } catch {
      // Completion observers cannot turn a successful write into a failure.
    }
  }

  let after = finalAfter;
  const presentationContext: TextPresentationContext = {
    purpose: "edit-diff",
    source: request.resource.source,
    cwd: request.context.cwd,
    resolvedBy: request.resolvedBy,
    ...(request.context.signal !== undefined && { signal: request.context.signal }),
  };

  for (const { registration } of request.context.signal?.aborted ? [] : request.presenters) {
    after = await registration.presenter.present(after, presentationContext);
  }

  return {
    kind: "completed",
    source: request.outcomeSource,
    resolvedBy: request.resolvedBy,
    before: request.before,
    after,
    result: request.result,
    postEditContributions,
  };
}

async function editTextResource<Result>(
  source: string,
  context: ResourceResolverContext,
  resolvers: readonly RegisteredResolver[],
  anchorResolvers: TextAnchorRegistrySnapshot,
  presenters: readonly RegisteredPresenter[],
  postEditHandlers: readonly TextPostEditHandlerRegistration[],
  editCompletionListeners: readonly TextEditCompletionListener[],
  operation: (
    text: string,
    resolveAnchor: ResolveTextAnchor,
  ) => TextMutationResult<Result> | Promise<TextMutationResult<Result>>,
): Promise<TextResourceEditOutcome<Result>> {
  if (source.length === 0) {
    return {
      kind: "failed",
      failure: {
        code: "INVALID_REQUEST",
        source,
        message: "No source was provided",
      },
    };
  }

  for (const { resolver } of resolvers) {
    let attempt: unknown;

    try {
      attempt = await resolver.tryResolve(source, context);
    } catch (error) {
      return {
        kind: "failed",
        failure: {
          code: "RESOLVE_FAILED",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} failed`,
          cause: error,
        },
      };
    }

    if (!isResourceResolutionAttempt(attempt)) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_RESOLVER_RESULT",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} returned an invalid result`,
          cause: attempt,
        },
      };
    }

    if (attempt.kind === "not-handled") {
      continue;
    }

    if (attempt.kind === "failed") {
      return {
        kind: "failed",
        failure: {
          code: "RESOLVE_FAILED",
          source,
          resolverId: resolver.id,
          message: `Resolver ${resolver.id} failed`,
          cause: attempt.error,
        },
      };
    }

    const resource = attempt.resource;

    if (resource.read === undefined || resource.write === undefined) {
      return {
        kind: "failed",
        failure: {
          code: "UNSUPPORTED_CAPABILITY",
          source: resource.source,
          resolverId: resolver.id,
          message: `Resource ${resource.source} does not support text editing`,
        },
      };
    }

    let content: unknown;

    try {
      content = await resource.read({
        ...(context.signal !== undefined && { signal: context.signal }),
      });
    } catch (error) {
      return {
        kind: "failed",
        failure: {
          code: "READ_FAILED",
          source: resource.source,
          resolverId: resolver.id,
          message: `Unable to read ${resource.source}`,
          cause: error,
        },
      };
    }

    if (!isAgentContent(content)) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_RESOURCE_CONTENT",
          source: resource.source,
          resolverId: resolver.id,
          message: `Resource ${resource.source} returned invalid content`,
          cause: content,
        },
      };
    }

    const block = content[0];

    if (content.length !== 1 || block.type !== "text") {
      return {
        kind: "failed",
        failure: {
          code: "UNSUPPORTED_CONTENT",
          source: resource.source,
          resolverId: resolver.id,
          message: `Resource ${resource.source} is not editable text`,
        },
      };
    }

    const before = createTextDocument(resource.source, block.text);
    const anchorContext: TextAnchorResolverContext = {
      source: resource.source,
      content: before.content,
      lines: before.lines.map((line) => line.content),
      cwd: context.cwd,
      ...(context.signal !== undefined && { signal: context.signal }),
    };
    const mutation = await operation(block.text, (value, kinds) =>
      anchorResolvers.resolve(
        value,
        anchorContext,
        kinds === undefined ? undefined : new Set(kinds),
      ),
    );
    const finalContent: unknown = [{ type: "text", text: mutation.text }];

    if (!isAgentContent(finalContent)) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_WRITE_CONTENT",
          source: resource.source,
          resolverId: resolver.id,
          message: `Text edit for ${resource.source} produced invalid content`,
          cause: mutation,
        },
      };
    }

    try {
      await resource.write(finalContent, {
        ...(context.signal !== undefined && { signal: context.signal }),
      });
    } catch (error) {
      return {
        kind: "failed",
        failure: {
          code: "WRITE_FAILED",
          source: resource.source,
          resolverId: resolver.id,
          message: `Unable to write ${resource.source}`,
          cause: error,
        },
      };
    }

    return finalizeTextResource({
      requestedSource: source,
      outcomeSource: resource.source,
      resource,
      resolvedBy: resolver.id,
      existed: true,
      before,
      requestedText: mutation.text,
      context,
      presenters,
      postEditHandlers,
      editCompletionListeners,
      result: mutation.result,
    });
  }

  return {
    kind: "failed",
    failure: {
      code: "NO_RESOLVER",
      source,
      message: `No resolver handled ${source}`,
    },
  };
}

async function runPreEditHandlers<Input>(
  initialState: TextPreEditState<Input>,
  handlers: readonly RegisteredHandler[],
  tool: TextEditorToolId,
): Promise<StageRunOutcome<TextPreEditState<Input>>> {
  let state = initialState;

  for (const registered of handlers) {
    if (registered.registration.stage !== "text-pre-edit") {
      continue;
    }

    try {
      state = (await registered.registration.handler(state)) as TextPreEditState<Input>;
    } catch (error) {
      return {
        kind: "failed",
        failure: pluginFailure(registered.pluginId, tool, "text-pre-edit", error),
      };
    }
  }

  return { kind: "completed", state };
}

async function runResultHandlers<Input, Result>(
  stage: "text-edit" | "text-post-edit",
  initialState: TextEditState<Input, Result>,
  handlers: readonly RegisteredHandler[],
  tool: TextEditorToolId,
): Promise<StageRunOutcome<TextEditState<Input, Result>>> {
  let state = initialState;

  for (const registered of handlers) {
    if (registered.registration.stage !== stage) {
      continue;
    }

    try {
      state = (await registered.registration.handler(state)) as TextEditState<Input, Result>;
    } catch (error) {
      return {
        kind: "failed",
        failure: pluginFailure(registered.pluginId, tool, stage, error),
      };
    }
  }

  return { kind: "completed", state };
}

function pluginFailure(
  pluginId: string,
  tool: TextEditorToolId,
  stage: TextEditPipelineStage,
  cause: unknown,
): TextEditPipelineFailure {
  return {
    code: "PLUGIN_FAILED",
    pluginId,
    tool,
    stage,
    message: `Plugin ${pluginId} failed during ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  };
}

function getPluginValidationError(plugin: {
  readonly apiVersion: number;
  readonly id: string;
  readonly protocol: string;
}): Error | undefined {
  if (plugin.protocol !== TEXT_EDITOR_PROTOCOL) {
    return new Error(`Plugin ${plugin.id} uses an unsupported protocol`);
  }

  if (plugin.apiVersion !== TEXT_EDITOR_API_VERSION) {
    return new Error(`Plugin ${plugin.id} uses an unsupported API version`);
  }

  if (plugin.id.trim().length === 0) {
    return new Error("Plugin ID must not be empty");
  }

  return undefined;
}

function createPluginContributionController(
  pluginId: string,
  registerContributions: (draft: PluginContributionDraft) => void,
  inspectTextAnchors: (
    request: TextAnchorInspectionRequest,
  ) => Promise<TextAnchorInspectionOutcome>,
  onMutationTool: (listener: TextMutationToolListener) => () => void,
  onDidEdit: (listener: TextEditCompletionListener) => () => void,
  previewMutation: (request: TextMutationPreviewRequest) => Promise<TextMutationPreviewOutcome>,
  recoveryConfig: (section: string) => TextEditorRecoveryConfigSection,
): PluginContributionController {
  const setupDraft: PluginContributionDraft = {
    resolvers: [],
    anchorResolvers: [],
    presenters: [],
    handlers: [],
    semanticHandlers: [],
    promptContributions: [],
    writablePromptContributions: [],
    tools: [],
    mutationTools: [],
    mutationToolListeners: [],
    editCompletionListeners: [],
    mutationGuards: [],
    toolRenderers: [],
  };
  let state: "active" | "closed" | "setup" = "setup";
  const assertAvailable = (): void => {
    if (state === "closed") {
      throw new Error(`Plugin ${pluginId} API is closed`);
    }
  };
  const createToolApi = (tool: TextEditorToolId): TextEditorToolPluginApi => ({
    addSemanticHandler(handler): void {
      assertAvailable();
      if (typeof handler.matches !== "function" || typeof handler.execute !== "function") {
        throw new TypeError(`Plugin ${pluginId} provided an invalid semantic handler for ${tool}`);
      }
      const contribution: RegisteredSemanticHandler = { pluginId, handler, tool };
      if (state === "setup") {
        const existing = requiredValue(setupDraft.semanticHandlers);
        if (existing.some((item) => item.pluginId === pluginId && item.tool === tool)) {
          throw new Error(`Plugin ${pluginId} already provides a semantic handler for ${tool}`);
        }
        existing.push(contribution);
        return;
      }
      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [],
        semanticHandlers: [contribution],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
      });
    },
    addHandler(registration): void {
      assertAvailable();

      if (!isTextEditHandlerRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid handler for ${tool}`);
      }

      const contribution: RegisteredHandler = { pluginId, registration, tool };

      if (state === "setup") {
        assertNoDraftHandler(setupDraft.handlers, contribution);
        setupDraft.handlers.push(contribution);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [contribution],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
      });
    },
    describe(description): void {
      assertAvailable();
      const contribution: PromptContribution = {
        description: normalizeDescription(`Plugin prompt description for ${tool}`, description),
        pluginId,
        tool,
      };

      if (state === "setup") {
        assertNoDraftDescription(setupDraft.promptContributions, contribution);
        setupDraft.promptContributions.push(contribution);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [],
        promptContributions: [contribution],
        writablePromptContributions: [],
        tools: [],
      });
    },
  });
  const api: TextEditorPluginApi = {
    addMutationTool(registration): void {
      assertAvailable();
      assertTextMutationToolRegistration(registration);

      if (state === "setup") {
        requiredValue(setupDraft.mutationTools).push(registration);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
        mutationTools: [registration],
      });
    },
    addToolRenderer(registration): void {
      assertAvailable();

      if (!isTextEditorToolRendererRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid text editor tool renderer`);
      }

      if (state === "setup") {
        requiredValue(setupDraft.toolRenderers).push(registration);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
        toolRenderers: [registration],
      });
    },
    addMutationGuard(registration): void {
      assertAvailable();

      if (registration.id.trim().length === 0 || typeof registration.guard !== "function") {
        throw new TypeError(`Plugin ${pluginId} provided an invalid mutation guard`);
      }

      if (state === "setup") {
        requiredValue(setupDraft.mutationGuards).push(registration);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
        mutationGuards: [registration],
      });
    },
    onMutationTool(listener): () => void {
      assertAvailable();

      if (state === "setup") {
        requiredValue(setupDraft.mutationToolListeners).push(listener);
        return () => {
          const index = requiredValue(setupDraft.mutationToolListeners).indexOf(listener);

          if (index !== -1) {
            requiredValue(setupDraft.mutationToolListeners).splice(index, 1);
          }
        };
      }

      return onMutationTool(listener);
    },
    onDidEdit(listener): () => void {
      assertAvailable();

      if (typeof listener !== "function") {
        throw new TypeError(`Plugin ${pluginId} provided an invalid edit completion listener`);
      }

      if (state === "setup") {
        requiredValue(setupDraft.editCompletionListeners).push(listener);
        return () => {
          const index = requiredValue(setupDraft.editCompletionListeners).indexOf(listener);

          if (index !== -1) {
            requiredValue(setupDraft.editCompletionListeners).splice(index, 1);
          }
        };
      }

      return onDidEdit(listener);
    },
    inspectTextAnchors(request): Promise<TextAnchorInspectionOutcome> {
      assertAvailable();
      return inspectTextAnchors(request);
    },
    recoveryConfig(section): TextEditorRecoveryConfigSection {
      assertAvailable();
      return recoveryConfig(section);
    },
    previewMutation(request): Promise<TextMutationPreviewOutcome> {
      assertAvailable();
      return previewMutation(request);
    },
    addResolver(registration): void {
      assertAvailable();

      if (!isResourceResolverRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid resource resolver`);
      }

      const contribution: ResolverContribution = { pluginId, registration };

      if (state === "setup") {
        assertNoDraftResolver(setupDraft.resolvers, contribution);
        setupDraft.resolvers.push(contribution);
        return;
      }

      registerContributions({
        resolvers: [contribution],
        anchorResolvers: [],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
      });
    },
    addAnchorResolver(registration): void {
      assertAvailable();

      if (!isTextAnchorResolverRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid text anchor resolver`);
      }

      const contribution: TextAnchorResolverContribution = { pluginId, registration };

      if (state === "setup") {
        setupDraft.anchorResolvers.push(contribution);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [contribution],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
      });
    },
    addTextPresenter(registration): void {
      assertAvailable();

      if (!isTextPresenterRegistration(registration)) {
        throw new TypeError(`Plugin ${pluginId} provided an invalid text presenter`);
      }

      const contribution: TextPresenterContribution = { pluginId, registration };

      if (state === "setup") {
        requiredValue(setupDraft.presenters).push(contribution);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        presenters: [contribution],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [],
        tools: [],
      });
    },
    describe(description): void {
      assertAvailable();

      if (setupDraft.writablePromptContributions.length > 0) {
        throw new Error(`Plugin ${pluginId} provides more than one writable resource description`);
      }

      const contribution: WritablePromptContribution = {
        description: normalizeDescriptionSource(description),
        pluginId,
      };

      if (state === "setup") {
        setupDraft.writablePromptContributions.push(contribution);
        return;
      }

      registerContributions({
        resolvers: [],
        anchorResolvers: [],
        handlers: [],
        promptContributions: [],
        writablePromptContributions: [contribution],
        tools: [],
      });
    },
    tool(tool): TextEditorToolPluginApi {
      assertAvailable();

      if (!isTextEditorToolId(tool)) {
        throw new Error(`Plugin ${pluginId} provided an invalid tool ID`);
      }

      if (state === "setup") {
        if (!setupDraft.tools.includes(tool)) {
          setupDraft.tools.push(tool);
        }
      } else {
        registerContributions({
          resolvers: [],
          anchorResolvers: [],
          handlers: [],
          promptContributions: [],
          writablePromptContributions: [],
          tools: [tool],
        });
      }

      return createToolApi(tool);
    },
  };

  return {
    api,
    close(): void {
      state = "closed";
    },
    commit(): void {
      if (state !== "setup") {
        throw new Error(`Plugin ${pluginId} setup contributions cannot be committed`);
      }

      registerContributions(setupDraft);
      state = "active";
    },
  };
}

function validateContributionDraft(
  draft: PluginContributionDraft,
  registeredResolvers: readonly RegisteredResolver[],
  registeredHandlers: readonly RegisteredHandler[],
  semanticHandlers: readonly RegisteredSemanticHandler[],
  registeredPromptContributions: readonly PromptContribution[],
  registeredWritablePromptContributions: readonly WritablePromptContribution[],
): void {
  const resolverIds = new Set(registeredResolvers.map(({ resolver }) => resolver.id));

  for (const contribution of draft.resolvers) {
    if (!isResourceResolverRegistration(contribution.registration)) {
      throw new TypeError(`Plugin ${contribution.pluginId} provided an invalid resource resolver`);
    }

    const resolverId = contribution.registration.resolver.id;

    if (resolverIds.has(resolverId)) {
      throw new Error(`Resource resolver ${resolverId} is already registered`);
    }

    resolverIds.add(resolverId);
  }

  const semanticKeys = new Set(
    semanticHandlers.map((handler) => `${handler.pluginId}\0${handler.tool}`),
  );
  for (const handler of draft.semanticHandlers ?? []) {
    if (
      typeof handler.handler.matches !== "function" ||
      typeof handler.handler.execute !== "function"
    ) {
      throw new TypeError(`Plugin ${handler.pluginId} provided an invalid semantic handler`);
    }
    const key = `${handler.pluginId}\0${handler.tool}`;
    if (semanticKeys.has(key)) {
      throw new Error(
        `Plugin ${handler.pluginId} already provides a semantic handler for ${handler.tool}`,
      );
    }
    semanticKeys.add(key);
  }
  const handlerKeys = new Set(registeredHandlers.map(handlerKey));

  for (const handler of draft.handlers) {
    if (!isTextEditHandlerRegistration(handler.registration)) {
      throw new TypeError(
        `Plugin ${handler.pluginId} provided an invalid handler for ${handler.tool}`,
      );
    }

    const key = handlerKey(handler);

    if (handlerKeys.has(key)) {
      throw new Error(
        `Plugin ${handler.pluginId} already handles ${handler.registration.stage} for ${handler.tool}`,
      );
    }

    handlerKeys.add(key);
  }

  const descriptionKeys = new Set(registeredPromptContributions.map(descriptionKey));

  for (const contribution of draft.promptContributions) {
    const key = descriptionKey(contribution);

    if (descriptionKeys.has(key)) {
      throw new Error(
        `Plugin ${contribution.pluginId} describes ${contribution.tool} more than once`,
      );
    }

    descriptionKeys.add(key);
  }

  const writablePluginIds = new Set(
    registeredWritablePromptContributions.map(({ pluginId }) => pluginId),
  );

  for (const contribution of draft.writablePromptContributions) {
    if (writablePluginIds.has(contribution.pluginId)) {
      throw new Error(
        `Plugin ${contribution.pluginId} provides more than one writable resource description`,
      );
    }

    writablePluginIds.add(contribution.pluginId);
  }

  for (const tool of draft.tools) {
    if (!isTextEditorToolId(tool)) {
      throw new TypeError("Plugin provided an invalid tool ID");
    }
  }
}

function assertNoDraftResolver(
  resolvers: readonly ResolverContribution[],
  incoming: ResolverContribution,
): void {
  const resolverId = incoming.registration.resolver.id;

  if (resolvers.some((resolver) => resolver.registration.resolver.id === resolverId)) {
    throw new Error(`Resource resolver ${resolverId} is already registered`);
  }
}

function assertNoDraftHandler(
  handlers: readonly RegisteredHandler[],
  incoming: RegisteredHandler,
): void {
  if (handlers.some((handler) => handlerKey(handler) === handlerKey(incoming))) {
    throw new Error(
      `Plugin ${incoming.pluginId} already handles ${incoming.registration.stage} for ${incoming.tool}`,
    );
  }
}

function assertNoDraftDescription(
  contributions: readonly PromptContribution[],
  incoming: PromptContribution,
): void {
  if (
    contributions.some((contribution) => descriptionKey(contribution) === descriptionKey(incoming))
  ) {
    throw new Error(`Plugin ${incoming.pluginId} describes ${incoming.tool} more than once`);
  }
}

function handlerKey(handler: RegisteredHandler): string {
  return `${handler.pluginId}\0${handler.tool}\0${handler.registration.stage}`;
}

function descriptionKey(contribution: PromptContribution): string {
  return `${contribution.pluginId}\0${contribution.tool}`;
}

function normalizeDescriptionSource(value: unknown): PromptDescriptionSource {
  if (typeof value === "string") {
    return normalizeDescription("Writable resource prompt description", value);
  }

  if (typeof value === "function") {
    return value as () => string | undefined;
  }

  throw new TypeError("Writable resource prompt description must be a string or callback");
}

function renderDescriptionSource(source: PromptDescriptionSource): string | undefined {
  if (typeof source === "string") {
    return source;
  }

  const value: unknown = source();
  return value === undefined
    ? undefined
    : normalizeDescription("Writable resource prompt description", value);
}

function normalizeDescription(label: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  const lines = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  while (lines[0]?.trim().length === 0) {
    lines.shift();
  }

  while (lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }

  const description = lines.join("\n");

  if (description.trim().length === 0) {
    throw new Error(`${label} is empty`);
  }

  return description;
}

function renderPromptEntry(pluginId: string, description: string): string {
  const [firstLine, ...continuationLines] = description.split("\n");

  return [
    `- \`${escapeInlineCode(pluginId)}\` — ${firstLine ?? ""}`,
    ...continuationLines.map((line) => `  ${line}`),
  ].join("\n");
}

function indentGuidelineContinuation(guideline: string): string {
  const [firstLine, ...continuationLines] = guideline.split("\n");
  return [
    firstLine ?? "",
    ...continuationLines.map((line) => (line.length === 0 ? line : `  ${line}`)),
  ].join("\n");
}

function escapeInlineCode(value: string): string {
  return value.replaceAll("`", "\\`");
}

function mergeToolRenderer(
  current: TextEditorToolRendererRegistration | undefined,
  registration: TextEditorToolRendererRegistration,
): TextEditorToolRendererRegistration {
  if (registration.matches !== undefined) {
    const renderCall = registration.renderCall;
    const renderResult = registration.renderResult;
    const currentRenderCall = current?.renderCall;
    const currentRenderResult = current?.renderResult;
    return {
      ...current,
      tool: registration.tool,
      ...(renderCall === undefined
        ? {}
        : currentRenderCall === undefined
          ? { renderCall }
          : {
              renderCall: (...arguments_: Parameters<typeof renderCall>) =>
                registration.matches?.(arguments_[0], "call") === true
                  ? renderCall(...arguments_)
                  : currentRenderCall(...arguments_),
            }),
      ...(renderResult === undefined
        ? {}
        : currentRenderResult === undefined
          ? { renderResult }
          : {
              renderResult: (...arguments_: Parameters<typeof renderResult>) =>
                registration.matches?.(arguments_[0], "result") === true
                  ? renderResult(...arguments_)
                  : currentRenderResult(...arguments_),
            }),
    };
  }
  const merged =
    registration.fallback === true
      ? { ...registration, ...current, tool: registration.tool }
      : { ...current, ...registration, tool: registration.tool };
  const { fallback: _fallback, matches: _matches, ...renderer } = merged;
  return renderer;
}

function replayMutationTools(
  listener: TextMutationToolListener,
  mutationTools: ReadonlyMap<string, AnyTextMutationToolRegistration>,
): void {
  for (const registration of mutationTools.values()) {
    listener(registration);
  }
}

function addMutationRegistration(
  registration: AnyTextMutationToolRegistration,
  mutationTools: Map<string, AnyTextMutationToolRegistration>,
  registeredTools: Set<TextEditorToolId>,
  listeners: Set<TextMutationToolListener>,
  registerMutationTool:
    | ((registration: AnyTextMutationToolRegistration, core: TextEditorCore) => void)
    | undefined,
  core: TextEditorCore,
): void {
  assertTextMutationToolRegistration(registration);

  if (mutationTools.has(registration.name)) {
    throw new Error(`Mutation tool ${registration.name} is already registered`);
  }

  mutationTools.set(registration.name, registration);
  registeredTools.add(registration.name);

  for (const listener of listeners) {
    listener(registration);
  }

  registerMutationTool?.(registration, core);
}
