import { requiredValue } from "pi-agent-invariant";
import { Text } from "@earendil-works/pi-tui";

import {
  TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH,
  type ToolCallAnchorRenderPatch,
} from "pi-agent-tool-call-interception";
import { singleLine, type ToolCallHeaderDetail } from "pi-agent-tool-ui";
import { NEXT_TOOL_CALL_DRAIN_MS, type MutationAnimationPressure } from "./animation-pressure.js";
import { loadRendererConfig } from "./config.js";
import { freezeMutationViewports, type FrozenMutationViewports } from "./frozen-viewport.js";
import { MutationPanel } from "./mutation-panel.js";
import {
  advanceTypingProjectionResources,
  extendTypingPreviewResources,
  preserveCompletedTypingRows,
  projectTypingResources,
} from "./mutation-projection.js";
import { resolveMutationResultResources } from "./mutation-result.js";
import { TYPING_FRAME_INTERVAL_MS, TypingInterpolation } from "./typing-interpolation.js";

import type { MutationRenderResource } from "./render-resource.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";
import type { FileMutationBatchResult } from "pi-agent-text-editor/api/mutation-result";
import type { AnyTextMutationToolRegistration } from "pi-agent-text-editor/api/mutation-tool";
import type { TextEditorPluginApi } from "pi-agent-text-editor/api/plugin-protocol";
import type { TextEditorToolRendererRegistration } from "pi-agent-text-editor/api/tool-renderer";

type MutationRenderOutcome =
  | { readonly kind: "completed"; readonly resources: readonly MutationRenderResource[] }
  | { readonly kind: "failed"; readonly reason: string };

const NO_TOOL_CALL_DETAILS: readonly ToolCallHeaderDetail[] = [];
const MAX_EXPANDED_GENERATED_ARGUMENT_CHARS = 120;

interface PreviewRequest {
  readonly identity: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly generated: string;
  readonly cwd: string;
}

interface PreviewTarget {
  readonly identity: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly generated: string;
  readonly resources: readonly TextMutationPreviewResource[];
}

interface PendingResult {
  readonly details: FileMutationBatchResult | undefined;
  readonly expanded: boolean;
  readonly theme: Theme;
}

interface RenderState {
  registration: AnyTextMutationToolRegistration;
  epoch?: number;
  controller?: AbortController;
  key?: string;
  preview?: MutationRenderOutcome;
  viewports?: FrozenMutationViewports;
  panel?: MutationPanel;

  stableHeader?: { readonly value: string; readonly expanded: boolean };
  input?: Readonly<Record<string, unknown>>;
  theme?: Theme;
  cwd?: string;
  expanded?: boolean;
  invalidate?: () => void;
  latestGenerated?: string;
  typing?: TypingInterpolation;
  target?: PreviewTarget;
  queuedPreview?: PreviewRequest;
  previewRunning?: boolean;
  timer?: ReturnType<typeof setInterval>;

  displayedResources?: readonly MutationRenderResource[];
  displayedText?: string;
  [TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH]?: ToolCallAnchorRenderPatch;

  pendingResult?: PendingResult;
  releaseAnimationPressure?: () => void;
}

/** Register mutation renderers with optional model-stream animation pressure. */
export function registerMutationRenderers(
  api: TextEditorPluginApi,
  animationPressure?: MutationAnimationPressure,
): void {
  api.onMutationTool((registration) => {
    api.addToolRenderer(createRenderer(api, registration, animationPressure));
  });
}

function createRenderer(
  api: TextEditorPluginApi,
  registration: AnyTextMutationToolRegistration,
  animationPressure?: MutationAnimationPressure,
): TextEditorToolRendererRegistration {
  const tool = registration.name;

  return {
    tool,
    fallback: true,
    ...(tool === "write" && { renderShell: "self" as const }),
    renderCall(arguments_, theme, context) {
      const component = panel(context.lastComponent, theme, tool === "write");
      const input = asInput(arguments_);
      const state = context.state as RenderState;
      state.registration = registration;
      const now = performance.now();
      state.panel = component;
      state.input = input;
      state.theme = theme;
      state.invalidate = context.invalidate;
      // renderCall runs on every frame, so reapply the project's viewport policy each time.
      state.cwd = context.cwd;
      component.setExpanded(context.expanded || preferFullDiff(context.cwd));
      state.expanded = context.expanded;

      component.setResourceLabelsVisible(
        stringValue(input[registration.source.field]) === undefined,
      );
      component.setBackground(context.isError ? "toolErrorBg" : "toolPendingBg");

      const generated = generatedText(tool, input);
      const renderedHeader = renderHeader(
        registration,
        input,
        state.preview,
        theme,
        state[TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH],
        context.expanded,
      );
      const sourceReady =
        stringValue(input[registration.source.field]) !== undefined ||
        state.preview?.kind === "completed";
      const argumentsReady =
        generatedField(tool) === undefined ? context.argsComplete : generated !== undefined;
      const canFreezeHeader = sourceReady && argumentsReady;
      const stableHeader =
        state.stableHeader?.expanded === context.expanded
          ? state.stableHeader
          : { value: renderedHeader, expanded: context.expanded };
      if (canFreezeHeader) {
        state.stableHeader = stableHeader;
      }
      component.setHeader(
        canFreezeHeader ? stableHeader.value : renderedHeader,
        mutationCallDetails(registration.name, input, context.expanded),
        context.expanded,
      );

      if (!context.isPartial && !context.argsComplete) {
        disposeRenderState(state);
        return component;
      }

      const isArgumentsComplete = context.argsComplete;
      const key = `${isArgumentsComplete ? "complete" : "typing"}:${JSON.stringify(input)}`;

      if (generated !== undefined) {
        const typing = (state.typing ??= new TypingInterpolation());

        state.releaseAnimationPressure ??= animationPressure?.track(context.toolCallId, () => {
          state.typing?.finish(performance.now(), NEXT_TOOL_CALL_DRAIN_MS);
          ensureTypingTimer(state);
        });
        typing.observe(generated, now);
        state.latestGenerated = generated;

        if (isArgumentsComplete) {
          typing.finish(now);
        }

        if (state.key !== key && generated.length > 0) {
          state.key = key;
          const request = {
            identity: previewIdentity(tool, input),
            input,
            generated,
            cwd: context.cwd,
          } satisfies PreviewRequest;

          if (!advancePreviewTarget(state, request, now)) {
            queuePreview(state, request, api, tool);
          }
        }

        ensureTypingTimer(state);
      }

      if (state.preview?.kind === "completed" && !component.hasResources()) {
        component.setPreviewResources(state.preview.resources);
      }

      return component;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as RenderState;
      state.registration = registration;
      const viewports = state.viewports;
      state.theme = theme;
      state.cwd = context.cwd;
      state.invalidate = context.invalidate;

      state.expanded = options.expanded;

      state.panel?.setBackground(context.isError ? "toolErrorBg" : "toolSuccessBg");
      cancelPreviewWorker(state);
      const resources = resolveMutationResultResources(result.details, viewports, false);

      if (!context.isError && resources.length > 0) {
        const typing = state.typing;
        const canFinishTyping =
          typing !== undefined &&
          state.target !== undefined &&
          state.latestGenerated === state.target.generated;

        if (canFinishTyping && !typing.caughtUp) {
          typing.finish(performance.now());
          state.pendingResult = { details: result.details, expanded: options.expanded, theme };
          ensureTypingTimer(state);
          return new Text("", 0, 0);
        }

        applyResultResources(
          state,
          resolveMutationResultResources(
            result.details,
            registration.name === "write" ? undefined : viewports,
          ),
          options.expanded,
          theme,
        );
        return new Text("", 0, 0);
      }

      clearTypingRuntime(state);
      delete state.preview;
      delete state.viewports;
      state.panel?.setHeader(
        renderHeader(
          registration,
          state.input ?? {},
          undefined,
          theme,
          state[TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH],
          options.expanded,
        ),
        mutationCallDetails(registration.name, state.input ?? {}, options.expanded),
        options.expanded,
      );
      state.panel?.setPreviewResources([]);

      const output = result.content
        .filter(
          (item): item is { readonly type: "text"; readonly text: string } => item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      const displayedOutput = context.isError ? userFacingFailure(output) : output;
      return new Text(
        displayedOutput.length === 0
          ? ""
          : theme.fg(context.isError ? "error" : "toolOutput", displayedOutput),
        0,
        0,
      );
    },
  };
}

const diffViewCache = new Map<string, boolean>();

/** Returns whether diffs should render fully by default for the given project. */
function preferFullDiff(cwd: string): boolean {
  let preferFull = diffViewCache.get(cwd);
  if (preferFull === undefined) {
    preferFull = loadRendererConfig(cwd).diffView === "full";
    diffViewCache.set(cwd, preferFull);
  }
  return preferFull;
}

function panel(previous: unknown, theme: Theme, ownsShell: boolean): MutationPanel {
  const component =
    previous instanceof MutationPanel ? previous : new MutationPanel(theme, ownsShell);
  component.setTheme(theme);
  return component;
}

function advancePreviewTarget(state: RenderState, request: PreviewRequest, now: number): boolean {
  const target = state.target;

  if (target?.identity !== request.identity) {
    return false;
  }

  const resources = extendTypingPreviewResources(
    target.resources,
    target.generated,
    request.generated,
  );

  if (resources === undefined) {
    return false;
  }

  if (state.previewRunning || state.queuedPreview !== undefined) {
    cancelPreviewWorker(state);
  }

  state.target = {
    identity: request.identity,
    input: request.input,
    generated: request.generated,
    resources,
  };
  state.typing?.setTarget(request.generated, now);
  return true;
}

function queuePreview(
  state: RenderState,
  request: PreviewRequest,
  api: TextEditorPluginApi,
  tool: string,
): void {
  state.queuedPreview = request;

  if (state.previewRunning) {
    return;
  }

  const epoch = state.epoch ?? 0;
  state.epoch = epoch;
  state.previewRunning = true;
  // Restored rows receive their saved result synchronously. Let that result cancel
  // the preview before it can inspect today's file contents.
  void Promise.resolve()
    .then(() => runPreviewWorker(state, api, tool, epoch))
    .finally(() => {
      if (state.epoch !== epoch) {
        return;
      }

      state.previewRunning = false;

      if (state.queuedPreview !== undefined) {
        queuePreview(state, state.queuedPreview, api, tool);
      }
    });
}

async function runPreviewWorker(
  state: RenderState,
  api: TextEditorPluginApi,
  tool: string,
  epoch: number,
): Promise<void> {
  while (state.epoch === epoch) {
    const request = state.queuedPreview;

    if (request === undefined) {
      return;
    }

    delete state.queuedPreview;
    const controller = new AbortController();
    state.controller = controller;

    try {
      const preview = await api.previewMutation({
        tool,
        input: request.input,
        cwd: request.cwd,
        signal: controller.signal,
      });

      if (state.epoch !== epoch || controller.signal.aborted) {
        return;
      }

      if (preview.kind === "completed") {
        acceptPreview(state, request, preview.resources, performance.now());
      } else if (!hasQueuedPreview(state)) {
        showPreviewFailure(state, preview.reason);
      }
    } catch (error) {
      if (state.epoch !== epoch || controller.signal.aborted) {
        return;
      }

      if (!hasQueuedPreview(state)) {
        showPreviewFailure(state, error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (state.controller === controller) {
        delete state.controller;
      }
    }
  }
}

function hasQueuedPreview(state: RenderState): boolean {
  return state.queuedPreview !== undefined;
}

function acceptPreview(
  state: RenderState,
  request: PreviewRequest,
  resources: readonly TextMutationPreviewResource[],
  now: number,
): void {
  let targetRequest = request;
  let targetResources = resources;
  const queued = state.queuedPreview;

  if (queued?.identity === request.identity) {
    const promoted = extendTypingPreviewResources(resources, request.generated, queued.generated);

    if (promoted !== undefined) {
      targetRequest = queued;
      targetResources = promoted;
      delete state.queuedPreview;
    }
  }

  state.target = {
    identity: targetRequest.identity,
    input: targetRequest.input,
    generated: targetRequest.generated,
    resources: targetResources,
  };
  const typing = state.typing;
  const isRewound = typing?.setTarget(targetRequest.generated, now) ?? false;
  ensureTypingTimer(state);

  if ((isRewound || typing?.hasVisibleText === true) && updateTypingPanel(state)) {
    invalidateState(state);
  }
}

function showPreviewFailure(state: RenderState, reason: string): void {
  const preview = { kind: "failed", reason } as const;
  state.preview = preview;

  if (state.panel !== undefined && state.theme !== undefined) {
    state.panel.setHeader(
      state.stableHeader?.value ??
        renderHeader(
          state.registration,
          state.input ?? {},
          preview,
          state.theme,
          state[TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH],
          state.expanded ?? false,
        ),
      mutationCallDetails(state.registration.name, state.input ?? {}, state.expanded ?? false),
      state.expanded ?? false,
    );
  }
  invalidateState(state);
}

function ensureTypingTimer(state: RenderState): void {
  if (state.timer !== undefined || state.panel === undefined) {
    return;
  }

  state.timer = setInterval(() => {
    const typing = state.typing;
    let isChanged = false;

    if (typing?.advance(performance.now()) === true) {
      isChanged = updateTypingPanel(state);
    }

    if (
      state.pendingResult !== undefined &&
      typing?.caughtUp === true &&
      state.target?.generated === state.latestGenerated
    ) {
      isChanged = finishPendingResult(state) || isChanged;
    }

    if (isChanged) {
      invalidateState(state);
    }
  }, TYPING_FRAME_INTERVAL_MS);
  state.timer.unref();
}

function updateTypingPanel(state: RenderState): boolean {
  const target = state.target;
  const typing = state.typing;
  const component = state.panel;
  const theme = state.theme;

  if (
    target === undefined ||
    typing === undefined ||
    component === undefined ||
    theme === undefined
  ) {
    return false;
  }

  if (!typing.hasVisibleText && target.generated.length > 0) {
    return false;
  }

  const visibleText = typing.visibleText;
  const advanced =
    state.displayedResources === undefined || state.displayedText === undefined
      ? undefined
      : advanceTypingProjectionResources(
          target.resources,
          target.generated,
          state.displayedResources,
          state.displayedText,
          visibleText,
        );
  const resources =
    advanced ??
    preserveCompletedTypingRows(
      state.displayedResources ?? [],
      projectTypingResources(target.resources, target.generated, visibleText),
    );
  state.displayedResources = resources;
  state.displayedText = visibleText;
  const preview = { kind: "completed", resources } as const;
  state.preview = preview;
  state.viewports = freezeMutationViewports(resources);
  component.setPreviewResources(resources);
  component.setHeader(
    state.stableHeader?.value ??
      renderHeader(
        state.registration,
        state.input ?? target.input,
        preview,
        theme,
        state[TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH],
        state.expanded ?? false,
      ),
    mutationCallDetails(
      state.registration.name,
      state.input ?? target.input,
      state.expanded ?? false,
    ),
    state.expanded ?? false,
  );
  return true;
}

function finishPendingResult(state: RenderState): boolean {
  const pending = state.pendingResult;

  if (pending === undefined) {
    return false;
  }

  const resources = resolveMutationResultResources(pending.details, undefined);
  delete state.pendingResult;

  if (resources.length === 0) {
    clearTypingRuntime(state);
    return false;
  }

  applyResultResources(state, resources, pending.expanded, pending.theme);
  return true;
}

function applyResultResources(
  state: RenderState,
  resources: readonly MutationRenderResource[],
  expanded: boolean,
  theme: Theme,
): void {
  const stableResources = preserveCompletedTypingRows(state.displayedResources ?? [], resources);
  const preview = { kind: "completed", resources: stableResources } as const;
  state.preview = preview;
  state.panel?.setHeader(
    state.stableHeader?.value ??
      renderHeader(
        state.registration,
        state.input ?? {},
        preview,
        theme,
        state[TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH],
        expanded,
      ),
    mutationCallDetails(state.registration.name, state.input ?? {}, expanded),
    expanded,
  );
  state.panel?.setResultResources(stableResources);
  state.panel?.setExpanded(expanded || preferFullDiff(state.cwd ?? process.cwd()));
  clearTypingRuntime(state);
}

function cancelPreviewWorker(state: RenderState): void {
  state.epoch = (state.epoch ?? 0) + 1;
  state.controller?.abort();
  delete state.controller;
  delete state.queuedPreview;
  state.previewRunning = false;
}

function clearTypingRuntime(state: RenderState): void {
  if (state.timer !== undefined) {
    clearInterval(state.timer);
    delete state.timer;
  }

  delete state.stableHeader;
  delete state.typing;

  state.releaseAnimationPressure?.();
  delete state.releaseAnimationPressure;
  delete state.target;
  delete state.latestGenerated;
  delete state.displayedResources;
  delete state.displayedText;
  delete state.pendingResult;
  delete state.key;
}

function disposeRenderState(state: RenderState): void {
  cancelPreviewWorker(state);
  clearTypingRuntime(state);
}

function invalidateState(state: RenderState): void {
  if (state.invalidate === undefined || invalidateActiveRenderer(state.invalidate)) {
    return;
  }

  disposeRenderState(state);
}

function invalidateActiveRenderer(invalidate: () => void): boolean {
  try {
    invalidate();
    return true;
  } catch {
    // Session replacement disposes the renderer before pending previews finish.
    return false;
  }
}

function previewIdentity(tool: string, input: Readonly<Record<string, unknown>>): string {
  const field = generatedField(tool);
  return JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => key !== field)));
}

function generatedField(tool: string): string | undefined {
  return tool === "write"
    ? "content"
    : tool === "insert" || tool === "replace"
      ? "text"
      : undefined;
}

function generatedText(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const field = generatedField(tool);
  const value = field === undefined ? undefined : input[field];
  return typeof value === "string" ? value : undefined;
}

function asInput(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function mutationCallDetails(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  expanded: boolean,
): readonly ToolCallHeaderDetail[] {
  if (!expanded) {
    return NO_TOOL_CALL_DETAILS;
  }

  const generated = generatedField(tool);
  return Object.entries(input).map(([label, value]) => {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    const exact = typeof encoded === "string" ? encoded : String(value);
    return {
      label,
      value:
        label === generated && exact.length > MAX_EXPANDED_GENERATED_ARGUMENT_CHARS
          ? `${exact.slice(0, MAX_EXPANDED_GENERATED_ARGUMENT_CHARS)}… (${String(exact.length)} chars; full value shown in diff)`
          : exact,
    };
  });
}

function renderHeader(
  registration: AnyTextMutationToolRegistration,
  input: Readonly<Record<string, unknown>>,
  preview: MutationRenderOutcome | undefined,
  theme: Theme,
  anchorRenderPatch: ToolCallAnchorRenderPatch | undefined,
  expanded: boolean,
): string {
  const source = registration.source;
  const path = stringValue(input[source.field]);
  const previewResources = preview?.kind === "completed" ? preview.resources : [];
  const displayedPath =
    path ??
    (previewResources.length === 1
      ? requiredValue(previewResources[0]).path
      : previewResources.length > 1
        ? `${String(previewResources.length)} files`
        : "");
  const sourceLink =
    path === undefined && previewResources.length === 1
      ? requiredValue(previewResources[0]).link
      : resourceLink(preview, path);
  const targets = (source.targets ?? [])
    .map(({ field }) => ({ field, path: stringValue(input[field]) }))
    .filter(
      (target): target is { readonly field: string; readonly path: string } =>
        target.path !== undefined && target.path !== path,
    );
  let header = `${theme.fg("toolTitle", theme.bold(registration.name))} ${renderPath(
    displayedPath,
    sourceLink,
    theme,
  )}${renderAnchorRange(registration, source.field, input, anchorRenderPatch, theme, expanded)}`;

  for (const target of targets) {
    header += ` ${theme.fg("muted", "->")} ${renderPath(target.path, resourceLink(preview, target.path), theme)}`;
    header += renderAnchorRange(
      registration,
      target.field,
      input,
      anchorRenderPatch,
      theme,
      expanded,
    );
  }

  return header;
}

function renderAnchorRange(
  registration: AnyTextMutationToolRegistration,
  sourceField: string,
  input: Readonly<Record<string, unknown>>,
  anchorRenderPatch: ToolCallAnchorRenderPatch | undefined,
  theme: Theme,
  expanded: boolean,
): string {
  const anchors = (registration.anchors ?? []).filter(
    (anchor) => anchor.sourceField === sourceField,
  );
  const fields =
    sourceField === registration.source.field && registration.pair !== undefined
      ? registration.pair
      : anchors.slice(0, 2).map(({ field }) => field);
  const renderField = (field: string | undefined): string | undefined => {
    if (field === undefined) {
      return undefined;
    }
    const state = anchorRenderPatch?.[field];
    if (state?.kind === "resolved") {
      return singleLine(expanded ? state.full : state.compact);
    }
    if (state?.kind === "failed") {
      return "selected range";
    }
    const raw = stringValue(input[field]);
    if (raw === undefined) {
      return undefined;
    }
    return expanded ? singleLine(raw) : "selected range";
  };
  return range(renderField(fields.at(0)), renderField(fields.at(1)), theme);
}
function resourceLink(
  preview: MutationRenderOutcome | undefined,
  path: string | undefined,
): string | undefined {
  return preview?.kind === "completed"
    ? preview.resources.find((resource) => resource.path === path)?.link
    : undefined;
}

function renderPath(path: string, link: string | undefined, theme: Theme): string {
  if (path.length === 0) {
    return theme.fg("muted", "...");
  }

  const label = theme.underline(theme.fg("accent", path));
  return link === undefined || link.includes("\u{7}") || link.includes("\u{1B}")
    ? label
    : `\u{1B}]8;;${link}\u{7}${label}\u{1B}]8;;\u{7}`;
}

function range(start: string | undefined, end: string | undefined, theme: Theme): string {
  if (start === undefined) {
    return "";
  }

  const value = end === undefined ? start : semanticRange(start, end);
  return `${theme.fg("dim", " · ")}${theme.fg("warning", value)}`;
}

function semanticRange(start: string, end: string): string {
  const startLine = /^line (\d+)$/u.exec(start)?.[1];
  const endLine = /^line (\d+)$/u.exec(end)?.[1];
  return startLine !== undefined && endLine !== undefined
    ? `lines ${startLine}–${endLine}`
    : `${start}–${end}`;
}

function userFacingFailure(agentOutput: string): string {
  if (/\banchor\b[\s\S]*\bis ambiguous\./iu.test(agentOutput)) {
    return "Not changed · selection is ambiguous";
  }
  if (/\banchor\b[\s\S]*\bis stale\./iu.test(agentOutput)) {
    return "Not changed · selection is out of date";
  }
  if (/\banchor\b[\s\S]*\bwas not found\./iu.test(agentOutput)) {
    return "Not changed · selected text was not found";
  }
  if (/\banchor\b[\s\S]*\bis invalid\./iu.test(agentOutput)) {
    return "Not changed · selection is invalid";
  }
  return "Not changed · edit failed";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
