import {
  type Component,
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export const TOOL_CALL_INTERCEPTION_DETAILS_KEY = "pi-agent-text-editor/tool-call-interception";

export type ToolCallAnnotation =
  | {
      readonly kind: "stale-anchor";
      readonly label?: string;
      readonly reason?: string;
      readonly color?: ThemeColor;
    }
  | {
      readonly kind: "blocked";
      readonly label?: string;
      readonly reason: string;
      readonly color?: ThemeColor;
    }
  | {
      readonly kind: "aborted";
      readonly label?: string;
      readonly reason?: string;
      readonly color?: ThemeColor;
    }
  | {
      readonly kind: "custom";
      readonly label: string;
      readonly reason?: string;
      readonly color: ThemeColor;
    };

export interface ToolCallInterceptionDetails {
  readonly annotation: ToolCallAnnotation;
  readonly blocked?: { readonly reason: string };
}

const INTERCEPTION_ANNOTATION = Symbol("pi-agent-tool-call-interception/annotation");
const RENDER_ARGUMENT_PATCH = Symbol("pi-agent-tool-call-interception/render-argument-patch");

interface InterceptionRenderState {
  [INTERCEPTION_ANNOTATION]?: ToolCallAnnotation;
  [RENDER_ARGUMENT_PATCH]?: Readonly<Record<string, unknown>>;
}

interface ToolCallInterceptionRenderEntry {
  readonly annotation: ToolCallAnnotation | undefined;
  readonly renderArgumentPatch: Readonly<Record<string, unknown>> | undefined;
  readonly invalidate: (() => void) | undefined;
}

export function getToolCallInterception(details: unknown): ToolCallInterceptionDetails | undefined {
  if (!isRecord(details)) {
    return undefined;
  }

  const interception = details[TOOL_CALL_INTERCEPTION_DETAILS_KEY];
  return isToolCallInterceptionDetails(interception) ? interception : undefined;
}

export function withToolCallInterceptionDetails(
  details: unknown,
  annotation: ToolCallAnnotation,
  blockedReason?: string,
): Readonly<Record<string, unknown>> {
  const interception: ToolCallInterceptionDetails = {
    annotation,
    ...(blockedReason !== undefined && { blocked: { reason: blockedReason } }),
  };

  return isRecord(details)
    ? { ...details, [TOOL_CALL_INTERCEPTION_DETAILS_KEY]: interception }
    : { [TOOL_CALL_INTERCEPTION_DETAILS_KEY]: interception, agentDetails: details ?? null };
}

export function withBlockedToolResult<TDetails>(
  result: AgentToolResult<TDetails>,
  reason: string,
): AgentToolResult<TDetails> {
  return {
    ...result,
    details: withToolCallInterceptionDetails(
      result.details,
      { kind: "blocked", reason },
      reason,
    ) as TDetails,
  };
}

function sameArgumentPatch(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>>,
): boolean {
  if (left === undefined) {
    return false;
  }

  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every((key) => left[key] === right[key]);
}

export class ToolCallInterceptionRenderStore {
  private readonly entries = new Map<string, ToolCallInterceptionRenderEntry>();

  public readonly annotate = (toolCallId: string, annotation: ToolCallAnnotation): void => {
    const current = this.entries.get(toolCallId);
    this.entries.set(toolCallId, {
      annotation,
      renderArgumentPatch: current?.renderArgumentPatch,
      invalidate: current?.invalidate,
    });
    current?.invalidate?.();
  };

  public bind(toolCallId: string, invalidate: () => void): ToolCallAnnotation | undefined {
    const current = this.entries.get(toolCallId);
    this.entries.set(toolCallId, {
      annotation: current?.annotation,
      renderArgumentPatch: current?.renderArgumentPatch,
      invalidate,
    });
    return current?.annotation;
  }

  public get(toolCallId: string): ToolCallAnnotation | undefined {
    return this.entries.get(toolCallId)?.annotation;
  }

  public readonly resolveArguments = (
    toolCallId: string,
    patch: Readonly<Record<string, unknown>>,
  ): void => {
    const current = this.entries.get(toolCallId);

    if (sameArgumentPatch(current?.renderArgumentPatch, patch)) {
      return;
    }

    this.entries.set(toolCallId, {
      annotation: current?.annotation,
      renderArgumentPatch: patch,
      invalidate: current?.invalidate,
    });
    current?.invalidate?.();
  };

  public getRenderArgumentPatch(toolCallId: string): Readonly<Record<string, unknown>> | undefined {
    return this.entries.get(toolCallId)?.renderArgumentPatch;
  }

  public complete(toolCallId: string): void {
    this.entries.delete(toolCallId);
  }

  public clear(): void {
    this.entries.clear();
  }
}

class AnnotatedToolCall implements Component {
  public constructor(
    private component: Component,
    private theme: Theme,
    private state: InterceptionRenderState,
    private readonly annotations: ToolCallInterceptionRenderStore,
    private readonly toolCallId: string,
  ) {}

  public get inner(): Component {
    return this.component;
  }

  public update(component: Component, theme: Theme, state: InterceptionRenderState): void {
    this.component = component;
    this.theme = theme;
    this.state = state;
  }

  public render(width: number): string[] {
    const lines = this.component.render(width);
    const annotation = this.annotations.get(this.toolCallId) ?? this.state[INTERCEPTION_ANNOTATION];

    if (annotation === undefined) {
      return lines;
    }

    const rendered = renderAnnotation(annotation, this.theme);

    if (lines.length === 0) {
      return [truncateToWidth(rendered, width)];
    }

    const suffix = `  ← ${rendered}`;
    const suffixWidth = visibleWidth(suffix);

    if (suffixWidth >= width) {
      return [truncateToWidth(suffix.trimStart(), width, ""), ...lines.slice(1)];
    }

    return [
      `${truncateToWidth(lines[0] ?? "", width - suffixWidth, "")}${suffix}`,
      ...lines.slice(1),
    ];
  }

  public invalidate(): void {
    this.component.invalidate();
  }
}

export function withToolCallInterceptionRendering<TParameters extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
  annotations: ToolCallInterceptionRenderStore,
): ToolDefinition<TParameters, TDetails, TState> {
  const renderCall = definition.renderCall;
  const renderResult = definition.renderResult;

  return {
    ...definition,
    get promptGuidelines() {
      return definition.promptGuidelines;
    },
    renderCall(arguments_, theme, context) {
      const state = context.state as InterceptionRenderState;
      const annotation = annotations.bind(context.toolCallId, context.invalidate);
      const renderArgumentPatch =
        annotations.getRenderArgumentPatch(context.toolCallId) ?? state[RENDER_ARGUMENT_PATCH];

      if (renderArgumentPatch !== undefined) {
        state[RENDER_ARGUMENT_PATCH] = renderArgumentPatch;
      }

      const effectiveArguments =
        renderArgumentPatch === undefined
          ? arguments_
          : ({ ...renderArgumentPatch, ...arguments_ } as typeof arguments_);

      if (annotation !== undefined) {
        state[INTERCEPTION_ANNOTATION] = annotation;
      }

      const previous =
        context.lastComponent instanceof AnnotatedToolCall ? context.lastComponent : undefined;
      let component: Component;

      try {
        component =
          renderCall?.(effectiveArguments, theme, {
            ...context,
            args: effectiveArguments,
            lastComponent: previous?.inner,
          }) ?? fallbackCall(definition.name, theme);
      } catch {
        component = fallbackCall(definition.name, theme);
      }

      if (previous !== undefined) {
        previous.update(component, theme, state);
        return previous;
      }

      return new AnnotatedToolCall(component, theme, state, annotations, context.toolCallId);
    },
    renderResult(result, options, theme, context) {
      const state = context.state as InterceptionRenderState;
      const renderArgumentPatch =
        annotations.getRenderArgumentPatch(context.toolCallId) ?? state[RENDER_ARGUMENT_PATCH];

      if (renderArgumentPatch !== undefined) {
        state[RENDER_ARGUMENT_PATCH] = renderArgumentPatch;
      }

      const effectiveContext =
        renderArgumentPatch === undefined
          ? context
          : { ...context, args: { ...renderArgumentPatch, ...context.args } };
      const persisted = getToolCallInterception(result.details)?.annotation;
      const transient = annotations.get(context.toolCallId) ?? state[INTERCEPTION_ANNOTATION];
      const annotation =
        persisted ?? (options.isPartial || context.isError ? transient : undefined);

      if (annotation !== undefined) {
        state[INTERCEPTION_ANNOTATION] = annotation;
        annotations.complete(context.toolCallId);

        if (renderResult !== undefined) {
          const hiddenResult: AgentToolResult<TDetails> = {
            ...result,
            content: [],
            details: undefined as TDetails,
          };

          try {
            renderResult(hiddenResult, options, theme, effectiveContext);
          } catch {
            return new Container();
          }
        }

        return new Container();
      }

      annotations.complete(context.toolCallId);
      Reflect.deleteProperty(state, INTERCEPTION_ANNOTATION);

      if (renderResult !== undefined) {
        try {
          return renderResult(result, options, theme, effectiveContext);
        } catch {
          return fallbackResult(result, theme, context.isError);
        }
      }

      return fallbackResult(result, theme, context.isError);
    },
  };
}

function fallbackCall(name: string, theme: Theme): Component {
  return new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
}

function fallbackResult<TDetails>(
  result: AgentToolResult<TDetails>,
  theme: Theme,
  isError: boolean,
): Component {
  const output = result.content
    .filter(
      (item): item is { readonly type: "text"; readonly text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");

  return output.length === 0
    ? new Container()
    : new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}

function renderAnnotation(annotation: ToolCallAnnotation, theme: Theme): string {
  const isStale = annotation.kind === "stale-anchor";
  const icon = isStale ? "⚠" : "⊘";
  const label = annotation.label ?? (isStale ? "Stale Anchor" : "Blocked");
  const color = annotation.color ?? (isStale ? "warning" : "error");
  const reason = annotation.reason === undefined ? "" : `: ${annotation.reason}`;
  return theme.fg(color, `${icon} ${label}${reason}`);
}

function isToolCallInterceptionDetails(value: unknown): value is ToolCallInterceptionDetails {
  if (!isRecord(value) || !isToolCallAnnotation(value.annotation)) {
    return false;
  }

  return (
    value.blocked === undefined ||
    (isRecord(value.blocked) && typeof value.blocked.reason === "string")
  );
}

export function isToolCallAnnotation(value: unknown): value is ToolCallAnnotation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (
    (value.label !== undefined && typeof value.label !== "string") ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.color !== undefined && typeof value.color !== "string")
  ) {
    return false;
  }

  if (value.kind === "blocked") {
    return typeof value.reason === "string";
  }

  if (value.kind === "custom") {
    return typeof value.label === "string" && typeof value.color === "string";
  }

  return value.kind === "stale-anchor" || value.kind === "aborted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
