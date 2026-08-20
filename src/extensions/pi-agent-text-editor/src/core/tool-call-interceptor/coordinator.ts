/**
Runtime for intercepting streamed Pi tool calls.
*/

import { Allow } from "partial-json";
import {
  isToolCallAnnotation,
  type ToolCallAnnotation,
  withToolCallInterceptionDetails,
} from "pi-agent-tool-call-interception";
import { Guard } from "typebox-guard/guard";

import { resolvePartial } from "./partial-json-resolver.js";
import {
  type PartialToolRecoveryBatchEntry,
  PartialToolRecoveryRegistry,
  type PartialToolRecoveryResult,
} from "./partial-tool-recovery.js";
import { registerStreamingInterceptorProvider } from "./streaming-provider.js";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

export {
  getToolCallInterception,
  type ToolCallAnnotation,
  type ToolCallInterceptionDetails,
} from "pi-agent-tool-call-interception";

type AssistantStreamEvent = MessageUpdateEvent["assistantMessageEvent"];

interface PendingRecoveryBlock {
  readonly blocked: InterceptResult;
  readonly ctx: InterceptorContext;
}

// ── Utility type ──────────────────────────────────────────────────────

/**
Value or Promise of value — for sync/async interop.
*/
export type Awaitable<T> = T | Promise<T>;

export const PARTIAL_TOOL_RECOVERY_CUSTOM_TYPE = "agentic-ide-partial-tool-recovery";

export type ToolCallAnnotationSink = (toolCallId: string, annotation: ToolCallAnnotation) => void;

// The event bus connects guards and renderers even when Pi loads them as separate module instances.

const TOOL_CALL_ANNOTATION_EVENT = "pi-agent-text-editor/tool-call-annotation";
const toolCallAnnotationSinkUnsubscribers = new WeakMap<ExtensionAPI, () => void>();

interface ToolCallAnnotationEvent {
  readonly toolCallId: string;
  readonly annotation: ToolCallAnnotation;
}

export interface BlockedToolCallFact {
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly contentIndex?: number;
  readonly batchEntryIndex?: number;
  readonly details?: unknown;
  readonly result: AgentToolResult<unknown>;
  readonly nativeExecutionBlocked: boolean;
}

export type BlockedToolCallSink = (blocked: BlockedToolCallFact) => void;

// ── Public types ──────────────────────────────────────────────────────────

export interface InterceptResult {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  };
  annotation?: ToolCallAnnotation;
}

export interface GuardCallRecord {
  readonly originalArguments: Record<string, unknown>;
  readonly guardResult?: AgentToolResult<unknown>;
  readonly blockExecution?: boolean;
}

export interface GuardInterception {
  readonly toolCallId: string;
  readonly arguments: Record<string, unknown>;
  readonly result: AgentToolResult<unknown>;
}

export interface InterceptorContext {
  toolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
  };
  args: Record<string, unknown>;
  /**
    Stream content index, used to isolate interceptor state.
    */
  /**
    Position and calls within the current streamed tool-call batch.
    */
  batchEntryIndex?: number;
  batchEntries?: readonly PartialToolRecoveryBatchEntry[];
  contentIndex?: number;
  /**
    Best-effort parsed arguments during streaming (set on toolcall_delta).
    */
  partialArgs?: Record<string, unknown>;
  cwd: string;
  signal: AbortSignal | undefined;
  /**
    Extension context with UI methods (select, input, editor, confirm, etc.).
    */
  ctx: ExtensionContext;
}

export interface ToolCallInterceptorHandler {
  /**
    Unique handler name (for debug/removal).
    */
  name: string;
  toolNames: string[];
  /**
    Block Pi's native tool_call before execution. Existing cooperative executors may leave this disabled.
    */
  blockExecution?: boolean;
  /**
   * Optional lifecycle hooks for handlers that keep per-content state.
   */
  onContentEnd?(contentIndex: number): void;
  onAgentEnd?(): void;
  onAbort?(contentIndex: number): void;
  /**
   * Predicate. Called on each toolcall_start/delta/end for toolNames.
   * Return InterceptResult — intercept (abort; return the result through tool_result).
   * Return undefined — skip, next handler.
   * Can be sync or async (returns Awaitable).
   */
  intercept(context: InterceptorContext): Awaitable<InterceptResult | undefined>;
}

export interface ToolCallInterceptor {
  register(handler: ToolCallInterceptorHandler): void;
  unregister(name: string): void;
  registerRecovery(registration: Parameters<PartialToolRecoveryRegistry["register"]>[0]): void;
  unregisterRecovery(toolName: string): void;
  registerBlockedCallSink(sink: BlockedToolCallSink | undefined): void;
  processStreamEvent(
    event: AssistantStreamEvent,
    context: ExtensionContext,
  ): Promise<GuardInterception | undefined>;
  markStreamEventProcessed(event: AssistantStreamEvent): void;
  finalizeStreamInterception(contentIndex: number): void;
  getToolCallRecord(toolCallId: string): GuardCallRecord | undefined;
}

// ── Implementation ────────────────────────────────────────────────────────

class InterceptorImpl implements ToolCallInterceptor {
  /**
    toolName → handler[]
    */
  private readonly handlers = new Map<string, ToolCallInterceptorHandler[]>();
  private readonly recoveryRegistry = new PartialToolRecoveryRegistry();
  /**
    All blocked calls collected during the current assistant batch.
    */
  private readonly pendingRecoveryBlocks: PendingRecoveryBlock[] = [];
  /**
    Short reason for the guard that aborted the current assistant message.
    */
  private pendingAbortReason: string | undefined;
  /**
    Source batch indexes that recovery actually applied.
    */
  private readonly recoveryAppliedBatchIndexes = new Set<number>();
  /**
    Accumulated raw partial JSON arguments per contentIndex.
    */
  private readonly partialBuffers = new Map<number, string>();
  /**
    Content items whose complete JSON arguments were already intercepted.
    */
  private readonly completeArgumentContentIndices = new Set<number>();
  /**
    Content items whose complete JSON arguments were already intercepted.
    */
  /**
    Completed/partial calls in the current assistant batch.
    */
  private readonly streamedBatchEntries = new Map<number, PartialToolRecoveryBatchEntry>();
  /**
    contentIndex → local position within the current edit batch.
    */
  private readonly batchEntryIndexes = new Map<number, number>();
  /**
    toolCallId → local batch entry index, retained until tool_result arrives.
    */
  private readonly toolCallBatchEntryIndexes = new Map<string, number>();
  /**
    Batch entries whose tool execution has already returned a result.
    */
  private readonly completedBatchEntryIndexes = new Set<number>();
  private nextBatchEntryIndex = 0;
  /**
    contentIndex → toolName (recorded on toolcall_start).
    */
  private readonly contentNames = new Map<number, string>();
  /**
    contentIndex → renderer/tool call id.
    */
  private readonly contentToolCallIds = new Map<number, string>();
  /**
    Annotations queued until a streamed content item exposes its id.
    */
  private readonly pendingToolCallAnnotations = new Map<number, ToolCallAnnotation[]>();
  private readonly emittedToolCallAnnotationKinds = new Map<
    number,
    Set<ToolCallAnnotation["kind"]>
  >();

  /**
    contentIndex → tool was aborted in toolcall_delta (skip toolcall_end dispatch).
    */
  private readonly abortedContentIndices = new Set<number>();
  /**
    Serialize asynchronous handler dispatch for each streamed content item.
    */
  private readonly dispatchQueues = new Map<number, Promise<GuardInterception | undefined>>();
  /**
    Abort listeners installed for active content items.
    */
  private readonly abortCleanups = new Map<number, () => void>();
  /**
    Stream events already dispatched by the provider wrapper.
    */
  private readonly processedStreamEvents = new WeakSet<object>();
  /**
    Provider events may be cloned before message_update; track tool events by stable identity too.
    */
  private readonly processedStreamEventKeys = new Map<string, number>();
  /**
    Original streamed arguments and the result returned by a guard.
    */
  private readonly toolCallRecords = new Map<string, GuardCallRecord>();
  private blockedCallSink: BlockedToolCallSink | undefined;
  constructor(private readonly pi: ExtensionAPI) {
    pi.on("tool_call", (event) => {
      const record = this.toolCallRecords.get(event.toolCallId);
      const guardResult = record?.blockExecution ? record.guardResult : undefined;

      if (!guardResult) {
        return;
      }

      const reason = guardResult.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");

      return {
        block: true,
        reason: reason || `Tool call ${event.toolName} was blocked by a streaming interceptor.`,
      };
    });
    pi.on("tool_result", (event) => {
      const batchEntryIndex = this.toolCallBatchEntryIndexes.get(event.toolCallId);

      if (batchEntryIndex !== undefined) {
        this.completedBatchEntryIndexes.add(batchEntryIndex);
      }

      const guardResult = this.toolCallRecords.get(event.toolCallId)?.guardResult;
      this.toolCallRecords.delete(event.toolCallId);

      if (guardResult) {
        return {
          content: guardResult.content,
          details: guardResult.details,
          isError: true,
        };
      }

      return;
    });
    pi.on("message_update", async (event, context) => {
      const streamEvent = event.assistantMessageEvent;

      if (this.consumeProcessedStreamEvent(streamEvent)) {
        return;
      }

      await this.processStreamEvent(streamEvent, context);
    });

    pi.on("message_end", async (event) => {
      await this.finalizeRecovery();
      this.annotateIncompleteCalls();

      if (event.message.role !== "assistant") {
        return;
      }

      const reason = this.pendingAbortReason;
      this.pendingAbortReason = undefined;

      if (reason === undefined || event.message.stopReason !== "aborted") {
        return;
      }

      return {
        message: {
          ...event.message,
          errorMessage: reason,
        },
      };
    });

    pi.on("agent_end", async () => {
      await this.finalizeRecovery();

      for (const [contentIndex, entry] of this.streamedBatchEntries) {
        if (
          !entry.complete &&
          !this.recoveryAppliedBatchIndexes.has(entry.index) &&
          !this.emittedToolCallAnnotationKinds.get(contentIndex)?.has("stale-anchor")
        ) {
          this.annotateContent(contentIndex, { kind: "aborted" });
        }
      }

      this.cleanupAll();
    });
  }

  processStreamEvent(
    event: AssistantStreamEvent,
    context: ExtensionContext,
  ): Promise<GuardInterception | undefined> {
    if (event.type === "toolcall_start") {
      const block = event.partial.content[event.contentIndex];

      if (block?.type === "toolCall") {
        const batchEntryIndex = this.getOrCreateBatchEntryIndex(event.contentIndex);
        this.contentNames.set(event.contentIndex, block.name);

        if (typeof block.id === "string") {
          this.bindToolCallId(event.contentIndex, block.id);
        }

        this.partialBuffers.set(event.contentIndex, "");
        this.streamedBatchEntries.set(event.contentIndex, {
          index: batchEntryIndex,
          toolName: block.name,
          args: {},
          complete: false,
        });
        this.installAbortCleanup(event.contentIndex, context.signal);
      }

      return Promise.resolve(undefined as GuardInterception | undefined);
    }

    if (event.type === "toolcall_delta") {
      return this.enqueue(event.contentIndex, async () => {
        const toolName = this.contentNames.get(event.contentIndex);
        const toolCallId = this.contentToolCallIds.get(event.contentIndex);

        if (!toolName) {
          return;
        }

        const buffer = (this.partialBuffers.get(event.contentIndex) ?? "") + event.delta;
        this.partialBuffers.set(event.contentIndex, buffer);
        this.installAbortCleanup(event.contentIndex, context.signal);
        const partialArguments = resolvePartial(buffer, Allow.OBJ | Allow.ARR) ?? {};
        const completeArguments = parseCompleteArguments(buffer);
        const batchEntryIndex = this.getOrCreateBatchEntryIndex(event.contentIndex);
        this.streamedBatchEntries.set(event.contentIndex, {
          index: batchEntryIndex,
          toolName,
          args: partialArguments,
          complete: completeArguments !== undefined,
        });

        const handlers = this.handlers.get(toolName);

        if (
          !toolCallId ||
          !handlers ||
          handlers.length === 0 ||
          (!completeArguments && Object.keys(partialArguments).length === 0)
        ) {
          return;
        }

        const hasCompleteArguments = completeArguments !== undefined;

        if (hasCompleteArguments && this.completeArgumentContentIndices.has(event.contentIndex)) {
          return;
        }

        if (hasCompleteArguments) {
          this.completeArgumentContentIndices.add(event.contentIndex);
        }

        const arguments_ = completeArguments ?? partialArguments;
        const interception = await this.dispatchHandlers(handlers, {
          toolCall: { id: toolCallId, name: toolName, arguments: arguments_ },
          args: arguments_,
          ...(!hasCompleteArguments && { partialArgs: partialArguments }),
          batchEntryIndex,
          batchEntries: this.getBatchEntries(batchEntryIndex),
          contentIndex: event.contentIndex,
          cwd: context.cwd,
          signal: context.signal,
          ctx: context,
        });

        if (interception) {
          this.rememberOriginalArguments(interception.toolCallId, interception.arguments);
        }

        return interception;
      });
    }

    if (event.type === "toolcall_end") {
      return this.enqueue(event.contentIndex, async () => {
        const toolName = event.toolCall.name;
        const handlers = this.handlers.get(toolName);
        const batchEntryIndex = this.getOrCreateBatchEntryIndex(event.contentIndex);
        this.bindToolCallId(event.contentIndex, event.toolCall.id);
        const previous = this.toolCallRecords.get(event.toolCall.id);
        this.toolCallRecords.set(event.toolCall.id, {
          originalArguments: structuredClone(event.toolCall.arguments),
          ...(previous?.guardResult && { guardResult: previous.guardResult }),
          ...(previous?.blockExecution && { blockExecution: true }),
        });
        this.streamedBatchEntries.set(event.contentIndex, {
          index: batchEntryIndex,
          toolName,
          args: event.toolCall.arguments,
          complete: false,
        });

        const shouldIntercept = !this.completeArgumentContentIndices.has(event.contentIndex);
        let interception: GuardInterception | undefined;

        if (shouldIntercept) {
          this.completeArgumentContentIndices.add(event.contentIndex);
          interception =
            handlers && handlers.length > 0
              ? await this.dispatchHandlers(handlers, {
                  toolCall: event.toolCall,
                  args: event.toolCall.arguments,
                  batchEntryIndex,
                  batchEntries: this.getBatchEntries(batchEntryIndex),
                  contentIndex: event.contentIndex,
                  cwd: context.cwd,
                  signal: context.signal,
                  ctx: context,
                })
              : undefined;
        }

        const batchEntry = this.streamedBatchEntries.get(event.contentIndex);

        if (batchEntry) {
          this.streamedBatchEntries.set(event.contentIndex, { ...batchEntry, complete: true });
        }

        this.cleanupContent(event.contentIndex, toolName);
        return interception;
      });
    }

    return Promise.resolve(undefined as GuardInterception | undefined);
  }
  markStreamEventProcessed(event: AssistantStreamEvent): void {
    this.processedStreamEvents.add(event);
    const key = toolStreamEventKey(event);

    if (key !== undefined) {
      this.processedStreamEventKeys.set(key, (this.processedStreamEventKeys.get(key) ?? 0) + 1);
    }
  }

  private consumeProcessedStreamEvent(event: AssistantStreamEvent): boolean {
    const isSameEvent = this.processedStreamEvents.delete(event);
    const key = toolStreamEventKey(event);

    if (key === undefined) {
      return isSameEvent;
    }

    const count = this.processedStreamEventKeys.get(key) ?? 0;

    if (count === 0) {
      return isSameEvent;
    }

    if (count === 1) {
      this.processedStreamEventKeys.delete(key);
    } else {
      this.processedStreamEventKeys.set(key, count - 1);
    }

    return true;
  }

  finalizeStreamInterception(contentIndex: number): void {
    this.cleanupTransientContent(contentIndex, undefined, true);
  }

  getToolCallRecord(toolCallId: string): GuardCallRecord | undefined {
    return this.toolCallRecords.get(toolCallId);
  }

  private rememberOriginalArguments(
    toolCallId: string,
    originalArguments: Record<string, unknown>,
  ): void {
    const record = this.toolCallRecords.get(toolCallId);

    if (record) {
      this.toolCallRecords.set(toolCallId, {
        originalArguments: structuredClone(originalArguments),
        ...(record.guardResult && { guardResult: record.guardResult }),
        ...(record.blockExecution && { blockExecution: true }),
      });
    }
  }

  private async dispatchHandlers(
    handlers: readonly ToolCallInterceptorHandler[],
    context: InterceptorContext,
  ): Promise<GuardInterception | undefined> {
    for (const handler of handlers) {
      const result = await handler.intercept(context);

      if (result !== undefined) {
        this.pendingRecoveryBlocks.push({ blocked: result, ctx: context });
        const guardResult: AgentToolResult<unknown> = {
          content: [{ type: "text", text: result.message.content }],
          details: result.message.details ?? null,
        };
        this.blockedCallSink?.({
          callId: context.toolCall.id,
          toolName: context.toolCall.name,
          arguments: structuredClone(context.args),
          ...(context.contentIndex !== undefined && { contentIndex: context.contentIndex }),
          ...(context.batchEntryIndex !== undefined && {
            batchEntryIndex: context.batchEntryIndex,
          }),
          ...(result.message.details !== undefined && { details: result.message.details }),
          result: guardResult,
          nativeExecutionBlocked: handler.blockExecution === true,
        });
        return {
          toolCallId: context.toolCall.id,
          arguments: structuredClone(context.args),
          result: this.abortToolCall(
            result,
            context,
            handler.name,
            handler.blockExecution === true,
          ),
        };
      }
    }

    return undefined;
  }
  private annotateIncompleteCalls(): void {
    for (const [contentIndex, entry] of this.streamedBatchEntries) {
      if (
        !entry.complete &&
        !this.recoveryAppliedBatchIndexes.has(entry.index) &&
        !this.emittedToolCallAnnotationKinds.get(contentIndex)?.has("stale-anchor")
      ) {
        this.annotateContent(contentIndex, { kind: "aborted" });
      }
    }
  }

  private bindToolCallId(contentIndex: number, toolCallId: string): void {
    this.contentToolCallIds.set(contentIndex, toolCallId);
    const batchEntryIndex = this.batchEntryIndexes.get(contentIndex);

    if (batchEntryIndex !== undefined) {
      this.toolCallBatchEntryIndexes.set(toolCallId, batchEntryIndex);
    }

    const pending = this.pendingToolCallAnnotations.get(contentIndex);

    if (!pending) {
      return;
    }

    for (const annotation of pending) {
      this.emitToolCallAnnotation(toolCallId, annotation);
    }

    this.pendingToolCallAnnotations.delete(contentIndex);
  }

  private annotateContent(contentIndex: number, annotation: ToolCallAnnotation): void {
    const emitted =
      this.emittedToolCallAnnotationKinds.get(contentIndex) ??
      new Set<ToolCallAnnotation["kind"]>();

    if (emitted.has(annotation.kind)) {
      return;
    }

    emitted.add(annotation.kind);
    this.emittedToolCallAnnotationKinds.set(contentIndex, emitted);

    const toolCallId = this.contentToolCallIds.get(contentIndex);

    if (toolCallId) {
      this.emitToolCallAnnotation(toolCallId, annotation);
      return;
    }

    const pending = this.pendingToolCallAnnotations.get(contentIndex) ?? [];
    pending.push(annotation);
    this.pendingToolCallAnnotations.set(contentIndex, pending);
  }

  private emitToolCallAnnotation(toolCallId: string, annotation: ToolCallAnnotation): void {
    const event = { toolCallId, annotation } satisfies ToolCallAnnotationEvent;
    this.pi.events.emit(TOOL_CALL_ANNOTATION_EVENT, event);
  }

  private getOrCreateBatchEntryIndex(contentIndex: number): number {
    const existing = this.batchEntryIndexes.get(contentIndex);

    if (existing !== undefined) {
      return existing;
    }

    const created = this.nextBatchEntryIndex;
    this.nextBatchEntryIndex += 1;
    this.batchEntryIndexes.set(contentIndex, created);
    return created;
  }

  private getBatchEntries(batchEntryIndex: number): readonly PartialToolRecoveryBatchEntry[] {
    return [...this.streamedBatchEntries.values()]
      .filter((entry) => entry.index <= batchEntryIndex)
      .sort((left, right) => left.index - right.index);
  }

  private getAllBatchEntries(): readonly PartialToolRecoveryBatchEntry[] {
    return [...this.streamedBatchEntries.values()].sort((left, right) => left.index - right.index);
  }

  private abortToolCall(
    result: InterceptResult,
    context: InterceptorContext,
    handlerName: string,
    blockExecution: boolean,
  ): AgentToolResult<unknown> {
    const reason = abortReason(result, handlerName);
    const annotation: ToolCallAnnotation = result.annotation
      ? result.annotation.kind === "aborted" && result.annotation.label === undefined
        ? { ...result.annotation, label: reason }
        : result.annotation
      : result.message.customType === "text-editor-stale-anchor-block"
        ? { kind: "stale-anchor", label: reason }
        : { kind: "aborted", label: reason, color: "error" };

    if (context.contentIndex !== undefined) {
      this.abortedContentIndices.add(context.contentIndex);
      this.annotateContent(context.contentIndex, annotation);
    }

    const guardResult: AgentToolResult<unknown> = {
      content: [{ type: "text", text: result.message.content }],
      details: withToolCallInterceptionDetails(result.message.details, annotation, reason),
    };
    this.toolCallRecords.set(context.toolCall.id, {
      originalArguments: structuredClone(context.args),
      guardResult,
      ...(blockExecution && { blockExecution: true }),
    });
    return guardResult;
  }

  private async finalizeRecovery(): Promise<void> {
    const pending = this.pendingRecoveryBlocks.splice(0);

    if (pending.length === 0) {
      return;
    }

    const groups = new Map<string, PendingRecoveryBlock[]>();

    for (const block of pending) {
      const recoveryKey = this.recoveryRegistry.recoveryKeyFor(block.ctx.toolCall.name);

      if (recoveryKey === undefined) {
        continue;
      }

      const group = groups.get(recoveryKey) ?? [];
      group.push(block);
      groups.set(recoveryKey, group);
    }

    for (const group of groups.values()) {
      const first = group[0];

      if (!first) {
        continue;
      }

      const finalResult = await this.recoverIfNeeded(
        first.blocked,
        first.ctx,
        this.getAllBatchEntries(),
        group,
      );

      if (finalResult === first.blocked) {
        continue;
      }

      const details = finalResult.message.details;
      const recovery =
        Guard.IsObjectNotArray(details) && Guard.IsObjectNotArray(details.recovery)
          ? details.recovery
          : undefined;
      const appliedEntries = recovery?.appliedEntries;

      if (Array.isArray(appliedEntries)) {
        for (const index of appliedEntries) {
          if (typeof index === "number") {
            this.recoveryAppliedBatchIndexes.add(index);
          }
        }
      }
    }
  }

  private async recoverIfNeeded(
    result: InterceptResult,
    context: InterceptorContext,
    finalBatchEntries: readonly PartialToolRecoveryBatchEntry[],
    blocks: readonly PendingRecoveryBlock[],
  ): Promise<InterceptResult> {
    if (context.contentIndex === undefined) {
      return result;
    }

    const details = result.message.details;
    const staleEntryIndex =
      Guard.IsObjectNotArray(details) && typeof details.entryIndex === "number"
        ? details.entryIndex
        : undefined;
    const blockedEntryIndexes = [
      ...new Set(
        blocks
          .map((block) => block.ctx.batchEntryIndex)
          .filter((index): index is number => index !== undefined),
      ),
    ];
    const blockedToolCallIds = [...new Set(blocks.map((block) => block.ctx.toolCall.id))];
    const blockedDetails = blocks.map((block) => block.blocked.message.details);
    const first = blocks[0];
    const recoveryKey = first
      ? this.recoveryRegistry.recoveryKeyFor(first.ctx.toolCall.name)
      : undefined;

    if (!recoveryKey) {
      return result;
    }

    const recovery = await this.recoveryRegistry.recover({
      contentIndex: context.contentIndex,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      ...(staleEntryIndex !== undefined && { staleEntryIndex }),
      staleDetails: details,
      ...(context.partialArgs && { partialArgs: context.partialArgs }),
      args: context.args,
      batchEntries: finalBatchEntries,
      ...(context.batchEntryIndex !== undefined && { batchEntryIndex: context.batchEntryIndex }),
      recoverCompleteBatch: true,
      completedEntryIndexes: [...this.completedBatchEntryIndexes],
      blockedEntryIndexes,
      blockedToolCallIds,
      blockedDetails,
      recoveryKey,
      cwd: context.cwd,
      ctx: context.ctx,
    });

    return recovery && (recovery.appliedEntries.length > 0 || recovery.skippedEntries.length > 0)
      ? makeRecoveryResult(result, recovery)
      : result;
  }
  private async enqueue(
    contentIndex: number,
    task: () => Promise<GuardInterception | undefined>,
  ): Promise<GuardInterception | undefined> {
    const previous = this.dispatchQueues.get(contentIndex) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.dispatchQueues.set(contentIndex, current);

    try {
      return await current;
    } finally {
      if (this.dispatchQueues.get(contentIndex) === current) {
        this.dispatchQueues.delete(contentIndex);
      }
    }
  }

  private installAbortCleanup(contentIndex: number, signal: AbortSignal | undefined): void {
    if (!signal || this.abortCleanups.has(contentIndex)) {
      return;
    }

    const listener = () => {
      const toolName = this.contentNames.get(contentIndex);
      const handlers = toolName ? this.handlers.get(toolName) : undefined;

      for (const handler of handlers ?? []) {
        handler.onAbort?.(contentIndex);
      }
    };

    signal.addEventListener("abort", listener, { once: true });
    this.abortCleanups.set(contentIndex, () => {
      signal.removeEventListener("abort", listener);
    });
  }

  private cleanupContent(contentIndex: number, toolName?: string): void {
    this.cleanupTransientContent(contentIndex, toolName);
    this.recoveryRegistry.cleanup(contentIndex);
  }

  private cleanupTransientContent(contentIndex: number, toolName?: string, aborted = false): void {
    const name = toolName ?? this.contentNames.get(contentIndex);
    const handlers = name ? this.handlers.get(name) : undefined;

    for (const handler of handlers ?? []) {
      if (aborted) {
        handler.onAbort?.(contentIndex);
      }

      handler.onContentEnd?.(contentIndex);
    }

    this.abortCleanups.get(contentIndex)?.();
    this.abortCleanups.delete(contentIndex);
    this.contentNames.delete(contentIndex);
    this.contentToolCallIds.delete(contentIndex);
    this.pendingToolCallAnnotations.delete(contentIndex);
    this.emittedToolCallAnnotationKinds.delete(contentIndex);
    this.completeArgumentContentIndices.delete(contentIndex);
    this.partialBuffers.delete(contentIndex);
    this.abortedContentIndices.delete(contentIndex);
  }

  private cleanupAll(): void {
    for (const handlers of this.handlers.values()) {
      for (const handler of handlers) {
        handler.onAgentEnd?.();
      }
    }

    for (const cleanup of this.abortCleanups.values()) {
      cleanup();
    }

    this.abortCleanups.clear();
    this.contentNames.clear();
    this.contentToolCallIds.clear();
    this.pendingToolCallAnnotations.clear();
    this.completeArgumentContentIndices.clear();
    this.emittedToolCallAnnotationKinds.clear();
    this.partialBuffers.clear();
    this.streamedBatchEntries.clear();
    this.batchEntryIndexes.clear();
    this.toolCallBatchEntryIndexes.clear();
    this.toolCallRecords.clear();
    this.completedBatchEntryIndexes.clear();
    this.nextBatchEntryIndex = 0;
    this.abortedContentIndices.clear();
    this.pendingAbortReason = undefined;
    this.dispatchQueues.clear();
    this.processedStreamEventKeys.clear();
    this.recoveryRegistry.cleanupAll();
    this.pendingRecoveryBlocks.length = 0;
    this.recoveryAppliedBatchIndexes.clear();
  }

  registerRecovery(registration: Parameters<PartialToolRecoveryRegistry["register"]>[0]): void {
    this.recoveryRegistry.register(registration);
  }

  unregisterRecovery(toolName: string): void {
    this.recoveryRegistry.unregister(toolName);
  }

  registerBlockedCallSink(sink: BlockedToolCallSink | undefined): void {
    this.blockedCallSink = sink;
  }

  register(handler: ToolCallInterceptorHandler): void {
    const targetTools = new Set(handler.toolNames);

    for (const [toolName, handlers] of this.handlers) {
      const index = handlers.findIndex((current) => current.name === handler.name);

      if (index === -1) {
        continue;
      }

      if (targetTools.has(toolName)) {
        handlers[index] = handler;
        targetTools.delete(toolName);
      } else {
        handlers.splice(index, 1);
      }
    }

    for (const toolName of targetTools) {
      const handlers = this.handlers.get(toolName) ?? [];
      handlers.push(handler);
      this.handlers.set(toolName, handlers);
    }
  }

  unregister(name: string): void {
    for (const [toolName, handlers] of this.handlers) {
      this.handlers.set(
        toolName,
        handlers.filter((handler) => handler.name !== name),
      );
    }
  }
}

function toolStreamEventKey(event: AssistantStreamEvent): string | undefined {
  if (event.type === "toolcall_end") {
    return `${event.type}\u{0}${event.contentIndex}\u{0}${event.toolCall.id}`;
  }

  if (event.type !== "toolcall_start" && event.type !== "toolcall_delta") {
    return undefined;
  }

  const block = event.partial.content[event.contentIndex];
  const toolCallId = block?.type === "toolCall" ? block.id : "";
  const delta = event.type === "toolcall_delta" ? event.delta : "";
  return `${event.type}\u{0}${event.contentIndex}\u{0}${toolCallId}\u{0}${delta}`;
}

function abortReason(result: InterceptResult, handlerName: string): string {
  if (result.annotation?.reason) {
    return result.annotation.reason;
  }

  if (result.annotation?.label) {
    return result.annotation.label;
  }

  if (result.message.customType === "text-editor-stale-anchor-block") {
    return "Stale Anchor";
  }

  return (
    handlerName
      .replace(/[-_]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Blocked"
  );
}

function parseCompleteArguments(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return Guard.IsObjectNotArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function freshAnchorsAfterRecovery(recovery: PartialToolRecoveryResult): string[] {
  const normalResult = recovery.normalResult;

  if (!Guard.IsObjectNotArray(normalResult) || !Guard.IsObjectNotArray(normalResult.details)) {
    return [];
  }

  const results = normalResult.details.results;

  if (!Array.isArray(results)) {
    return [];
  }

  const stalePath =
    Guard.IsObjectNotArray(recovery.staleDetails) && typeof recovery.staleDetails.path === "string"
      ? recovery.staleDetails.path
      : undefined;
  const candidates = results
    .filter(Guard.IsObjectNotArray)
    .map((result) => (Guard.IsObjectNotArray(result.data) ? result.data : result));
  const matching =
    stalePath === undefined ? candidates : candidates.filter((result) => result.path === stalePath);
  const selected = matching.length > 0 ? matching : candidates;
  const anchors = selected.flatMap((result) => {
    const freshAnchors = result.freshAnchors;
    return Array.isArray(freshAnchors)
      ? freshAnchors.filter((anchor): anchor is string => typeof anchor === "string")
      : [];
  });

  return [...new Set(anchors)];
}

function replaceCurrentAnchors(content: string, freshAnchors: readonly string[]): string {
  const marker = "\n\nCurrent nearby anchors:";
  const markerIndex = content.indexOf(marker);
  const base = markerIndex === -1 ? content : content.slice(0, markerIndex);
  return `${base}\n\nCurrent nearby anchors:\n${freshAnchors.map((anchor) => `  ${anchor}`).join("\n")}`;
}

function makeRecoveryResult(
  blocked: InterceptResult,
  recovery: PartialToolRecoveryResult,
): InterceptResult {
  const appliedCount = recovery.appliedEntries.length;
  const applied =
    appliedCount > 0 ? `${appliedCount} (indices: ${recovery.appliedEntries.join(", ")})` : "0";
  const skipped =
    recovery.skippedEntries.length > 0
      ? recovery.skippedEntries.map((entry) => `${entry.index} (${entry.reason})`).join(", ")
      : "none";
  const execution = recovery.error
    ? `Recovery execution failed: ${recovery.error}.`
    : "Recovery execution completed.";
  const freshAnchors = freshAnchorsAfterRecovery(recovery);
  const blockedDetails =
    freshAnchors.length > 0 && Guard.IsObjectNotArray(blocked.message.details)
      ? { ...blocked.message.details, freshAnchors }
      : blocked.message.details;
  const blockedContent =
    freshAnchors.length > 0
      ? replaceCurrentAnchors(blocked.message.content, freshAnchors)
      : blocked.message.content;
  const displayedRecovery =
    freshAnchors.length > 0 && Guard.IsObjectNotArray(recovery.staleDetails)
      ? { ...recovery, staleDetails: { ...recovery.staleDetails, freshAnchors } }
      : recovery;

  return {
    message: {
      customType: PARTIAL_TOOL_RECOVERY_CUSTOM_TYPE,
      content:
        `${blockedContent}\n\n[RECOVERY] Status: ${recovery.status}. Applied entries: ${applied}. ` +
        `Skipped entries: ${skipped}. ${execution}`,
      display: false,
      details: { blocked: blockedDetails, recovery: displayedRecovery },
    },
  };
}

const coordinators = new WeakMap<ExtensionAPI, ToolCallInterceptor>();

function coordinatorFor(pi: ExtensionAPI): ToolCallInterceptor {
  const existing = coordinators.get(pi);

  if (existing) {
    return existing;
  }

  const coordinator = new InterceptorImpl(pi);
  coordinators.set(pi, coordinator);
  registerStreamingInterceptorProvider(
    pi,
    (event, context) => coordinator.processStreamEvent(event, context),
    (event) => {
      coordinator.markStreamEventProcessed(event);
    },
    (contentIndex) => {
      coordinator.finalizeStreamInterception(contentIndex);
    },
  );
  return coordinator;
}

export function registerToolCallInterceptor(
  pi: ExtensionAPI,
  handler: ToolCallInterceptorHandler,
): void {
  coordinatorFor(pi).register(handler);
}

export function unregisterToolCallInterceptor(pi: ExtensionAPI, handlerName: string): void {
  coordinatorFor(pi).unregister(handlerName);
}

export function registerToolCallRecovery(
  pi: ExtensionAPI,
  registration: Parameters<PartialToolRecoveryRegistry["register"]>[0],
): void {
  coordinatorFor(pi).registerRecovery(registration);
}

export function unregisterToolCallRecovery(pi: ExtensionAPI, toolName: string): void {
  coordinatorFor(pi).unregisterRecovery(toolName);
}

export function registerToolCallAnnotationSink(
  pi: ExtensionAPI,
  sink?: ToolCallAnnotationSink,
): void {
  toolCallAnnotationSinkUnsubscribers.get(pi)?.();
  toolCallAnnotationSinkUnsubscribers.delete(pi);

  if (sink === undefined) {
    return;
  }

  const unsubscribe = pi.events.on(TOOL_CALL_ANNOTATION_EVENT, (event) => {
    if (
      !Guard.IsObjectNotArray(event) ||
      typeof event.toolCallId !== "string" ||
      !isToolCallAnnotation(event.annotation)
    ) {
      return;
    }

    sink(event.toolCallId, event.annotation);
  });
  toolCallAnnotationSinkUnsubscribers.set(pi, unsubscribe);
}

export function registerBlockedToolCallSink(
  pi: ExtensionAPI,
  sink: BlockedToolCallSink | undefined,
): void {
  coordinatorFor(pi).registerBlockedCallSink(sink);
}

export function processToolCallStreamEvent(
  pi: ExtensionAPI,
  event: AssistantStreamEvent,
  context: ExtensionContext,
): Promise<GuardInterception | undefined> {
  return coordinatorFor(pi).processStreamEvent(event, context);
}

export function markToolCallStreamEventProcessed(
  pi: ExtensionAPI,
  event: AssistantStreamEvent,
): void {
  coordinatorFor(pi).markStreamEventProcessed(event);
}

export function getToolCallRecord(
  pi: ExtensionAPI,
  toolCallId: string,
): GuardCallRecord | undefined {
  return coordinatorFor(pi).getToolCallRecord(toolCallId);
}
