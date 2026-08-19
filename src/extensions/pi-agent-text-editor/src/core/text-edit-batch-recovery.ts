import type { BatchCallCandidate, OriginalToolCall } from "./text-edit-batch-coordinator.js";
import type { BatchCallExecutionEntry, BatchExecutionReporter } from "./text-edit-batch-execution.js";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface BlockedToolCall
{
    readonly callId: string;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly contentIndex?: number;
    readonly batchEntryIndex?: number;
    readonly details?: unknown;
    readonly result: AgentToolResult<unknown>;
    readonly nativeExecutionBlocked: boolean;
}

export interface BatchRecoveryInput<TState = unknown>
{
    readonly batchId: string;
    readonly calls: readonly OriginalToolCall[];
    readonly candidates: readonly BatchCallCandidate<TState>[];
    readonly journal: readonly BatchCallExecutionEntry[];
    readonly blockedCalls: readonly BlockedToolCall[];
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly ctx: ExtensionContext;
}

export interface BatchRecoveryExecutionInput<TState = unknown> extends BatchRecoveryInput<TState>
{
    readonly selected: readonly BatchCallCandidate<TState>[];
    readonly reporter: BatchExecutionReporter;
}

export interface BatchRecoveryOutcome
{
    readonly results: ReadonlyMap<string, AgentToolResult<unknown>>;
    readonly skipped?: ReadonlyMap<string, string>;
}

export interface ToolBatchRecoveryDefinition<TState = unknown>
{
    select(input: BatchRecoveryInput<TState>): readonly string[];
    execute(input: BatchRecoveryExecutionInput<TState>): Promise<BatchRecoveryOutcome>;
}
