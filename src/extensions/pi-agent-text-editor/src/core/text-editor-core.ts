import { requiredValue } from "pi-agent-invariant";
import {
  isAgentContent,
  isResourceResolutionAttempt,
  type Resource,
  type ResourceResolver,
  type ResourceResolverContext,
  type ResourceWrite,
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
  readonly source: string;
  readonly read: boolean;
  readonly allowReadFailure?: boolean;
}

export interface TextResourcesMutationResult<Result> {
  readonly changes: ReadonlyMap<string, readonly TextChange[]>;
  readonly result: Result;
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
  readonly signal?: AbortSignal;
}

export interface TextResourcesEditContext
  extends ResourceResolverContext, TextMutationGuardContext {}

export interface TextEditorCore {
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
  renderGeneralPromptGuideline(): string | undefined;
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
  const registerContributions = (draft: PluginContributionDraft): void => {
    validateContributionDraft(
      draft,
      resolvers,
      handlers,
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

      return anchorRegistry.snapshot().resolve(request.value, context);
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
      return editTextResource(
        source,
        context,
        resolverSnapshot,
        anchorRegistry.snapshot(),
        presenterSnapshot,
        [...postEditHandlers.values()],
        [...editCompletionListeners],
        operation,
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
      return editTextResources(
        sources,
        context,
        resolverSnapshot,
        anchorRegistry.snapshot(),
        presenterSnapshot,
        [...postEditHandlers.values()],
        [...editCompletionListeners],
        [...mutationGuards],
        operation,
      );
    },
    previewTexts(sources, context, operation): Promise<TextMutationPreviewOutcome> {
      const resolverSnapshot = [...resolvers].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      );
      return previewTextResources(
        sources,
        context,
        resolverSnapshot,
        anchorRegistry.snapshot(),
        operation,
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
    renderGeneralPromptGuideline(): string | undefined {
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

      const anchorSection = anchorRegistry.renderPromptSection();

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
          entries.push(renderPromptEntry(registeredPlugin.plugin.id, contribution.description));
        }
      }

      return entries.length === 0
        ? undefined
        : indentGuidelineContinuation(
            [`${tool} supports these installed extensions:`, ...entries].join("\n"),
          );
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
        context,
        resolvers,
      );

      if ("failure" in outcome) {
        return { kind: "failed", reason: outcome.failure.message };
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
          : applyTextChanges(item.before.content, changes);
      return {
        path: source,
        existed: item.existed,
        beforeRanges: applied.changes.map(({ fromBefore: from, toBefore: to }) => ({ from, to })),
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
  readonly resource: Resource & { readonly write: ResourceWrite };
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

  for (const source of sources) {
    const request = requiredValue(requestBySource.get(source));
    const outcome = await prepareTextResource(
      source,
      request.read,
      request.allowReadFailure ?? false,
      context,
      resolvers,
    );

    if ("failure" in outcome) {
      return { kind: "failed", failure: outcome.failure, completed: [] };
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

  const applied = new Map<string, TextChangeResult>();

  for (const [source, changes] of mutation.changes) {
    const item = requiredValue(prepared.get(source));
    applied.set(source, applyTextChanges(item.before.content, changes));
  }

  const plan: TextMutationPlan = {
    resources: sources.flatMap((source) => {
      const item = requiredValue(prepared.get(source));
      const result = applied.get(source);

      return result === undefined || result.content === item.before.content
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

  const completed: string[] = [];
  const written: string[] = [];
  const outcomes: Exclude<TextResourceEditOutcome<unknown>, { readonly kind: "failed" }>[] = [];

  for (const source of sources) {
    const text = applied.get(source)?.content;
    const item = requiredValue(prepared.get(source));

    if (text === undefined || text === item.before.content) {
      continue;
    }

    const finalContent: unknown = [{ type: "text", text }];

    if (!isAgentContent(finalContent)) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_WRITE_CONTENT",
          source,
          message: `Text edit for ${source} produced invalid content`,
        },
        completed,
      };
    }

    try {
      await item.resource.write(
        finalContent,
        context.signal === undefined ? {} : { signal: context.signal },
      );
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const writtenSource of [source, ...written].reverse()) {
        const writtenItem = requiredValue(prepared.get(writtenSource));
        try {
          await writtenItem.resource.write(
            [{ type: "text", text: writtenItem.before.content }],
            {},
          );
        } catch {
          rollbackFailures.push(writtenSource);
        }
      }
      return {
        kind: "failed",
        failure: {
          code: "WRITE_FAILED",
          source,
          resolverId: item.resolverId,
          message:
            rollbackFailures.length === 0
              ? `Unable to write ${source}; completed writes were rolled back`
              : `Unable to write ${source}; rollback failed for ${rollbackFailures.join(", ")}`,
          cause: error,
        },
        completed: rollbackFailures,
      };
    }

    written.push(source);
    completed.push(source);
  }

  for (const source of written) {
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

  return { kind: "completed", resources: outcomes, result: mutation.result };
}

async function prepareTextResource(
  source: string,
  read: boolean,
  allowReadFailure: boolean,
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

    if (attempt.resource.write === undefined || (read && attempt.resource.read === undefined)) {
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
  const postEditContributions: TextPostEditContribution[] = [];

  for (const registration of request.postEditHandlers) {
    try {
      const data = await registration.handler(transaction);

      if (data !== undefined) {
        postEditContributions.push({ id: registration.id, data });
      }
    } catch {
      // Post-edit integrations do not change a successful write into a failure.
    }
  }

  let finalText = request.requestedText;

  if (request.resource.read !== undefined) {
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
    before: request.before,
    after: finalAfter,
    intent: request.context.intent ?? "edit",
  };

  for (const listener of request.editCompletionListeners) {
    try {
      await listener(completion);
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

  for (const { registration } of request.presenters) {
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
    message: `Plugin ${pluginId} failed during ${stage}`,
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
  const merged =
    registration.fallback === true
      ? { ...registration, ...current, tool: registration.tool }
      : { ...current, ...registration, tool: registration.tool };
  const { fallback: _fallback, ...renderer } = merged;
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
