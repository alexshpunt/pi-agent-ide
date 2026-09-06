import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface RecoveryEntry {
  readonly index: number;
  readonly value: Record<string, unknown>;
  readonly complete: boolean;
}

export interface PartialToolRecoveryBatchEntry {
  readonly index: number;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly complete: boolean;
}

export interface RecoverySkippedEntry {
  readonly index: number;
  readonly reason: string;
}

export interface RecoveryExecutionContext {
  readonly contentIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly cwd: string;
  readonly ctx: ExtensionContext;
  readonly signal: AbortSignal;
}

export interface PartialToolRecoveryInput {
  readonly contentIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly staleEntryIndex?: number;
  readonly staleDetails: unknown;
  readonly partialArgs?: Record<string, unknown>;
  readonly args: Record<string, unknown>;
  readonly batchEntries?: readonly PartialToolRecoveryBatchEntry[];
  readonly batchEntryIndex?: number;
  /**
    Include the complete compatible batch, including entries after the first stale one.
    */
  readonly recoverCompleteBatch?: boolean;
  /**
    Entries whose tool calls already completed before recovery started.
    */
  readonly completedEntryIndexes?: readonly number[];
  readonly cwd: string;
  /**
    All blocked source-entry indexes in the assistant batch.
    */
  readonly blockedEntryIndexes?: readonly number[];
  /**
    All blocked tool-call ids in the assistant batch.
    */
  readonly blockedToolCallIds?: readonly string[];
  /**
    Recovery registration key when several tool names share one batch recovery.
    */
  readonly recoveryKey?: string;
  /**
    Details for every blocked call, preserving multiple block reasons.
    */
  readonly blockedDetails?: readonly unknown[];
  readonly ctx: ExtensionContext;
}

export interface PartialToolRecoveryRegistration {
  readonly toolName: string;
  /**
    Optional key shared by guards that recover through one batch strategy.
    */
  readonly recoveryKey?: string;
  /**
    Tool names handled by a shared recovery strategy.
    */
  readonly toolNames?: readonly string[];
  readonly schema?: unknown;
  readonly extractEntries: (input: PartialToolRecoveryInput) => readonly RecoveryEntry[];
  readonly isCompleteEntry?: (entry: RecoveryEntry, input: PartialToolRecoveryInput) => boolean;
  readonly filterEntries?: (
    entries: readonly RecoveryEntry[],
    input: PartialToolRecoveryInput,
  ) => readonly RecoveryEntry[];
  /**
    Derive actually applied source-entry indices from the normal tool result.
    */
  readonly getAppliedEntries?: (
    normalResult: unknown,
    entries: readonly RecoveryEntry[],
    input: PartialToolRecoveryInput,
  ) => readonly number[];
  readonly buildParams: (
    entries: readonly RecoveryEntry[],
    input: PartialToolRecoveryInput,
  ) => Record<string, unknown>;
  readonly validateEntry?: (entry: RecoveryEntry, input: PartialToolRecoveryInput) => void;
  readonly execute: (
    parameters: Record<string, unknown>,
    context: RecoveryExecutionContext,
  ) => Promise<unknown>;
}

export interface PartialToolRecoveryResult {
  readonly status: "recovered" | "skipped" | "failed" | "already-recovered";
  readonly toolName: string;
  readonly contentIndex: number;
  readonly staleEntryIndex?: number;
  readonly appliedEntries: readonly number[];
  readonly skippedEntries: readonly RecoverySkippedEntry[];
  readonly staleDetails: unknown;
  readonly normalResult?: unknown;
  readonly error?: string;
}

type RecoveryState =
  | { status: "running"; promise: Promise<PartialToolRecoveryResult> }
  | { status: "done"; result: PartialToolRecoveryResult };

/**
Coordinates one partial recovery operation per streamed content item.
*/
export class PartialToolRecoveryRegistry {
  private readonly registrations = new Map<string, PartialToolRecoveryRegistration>();
  private readonly states = new Map<number, RecoveryState>();

  register(registration: PartialToolRecoveryRegistration): void {
    this.registrations.set(registration.recoveryKey ?? registration.toolName, registration);
  }

  unregister(toolName: string): void {
    for (const [key, registration] of this.registrations) {
      if (registration.toolName === toolName || key === toolName) {
        this.registrations.delete(key);
      }
    }
  }

  recoveryKeyFor(toolName: string): string | undefined {
    for (const [key, registration] of this.registrations) {
      if (
        registration.toolName === toolName ||
        registration.toolNames?.includes(toolName) ||
        key === toolName
      ) {
        return key;
      }
    }

    return undefined;
  }

  async recover(input: PartialToolRecoveryInput): Promise<PartialToolRecoveryResult | undefined> {
    const existing = this.states.get(input.contentIndex);

    if (existing?.status === "done") {
      return existing.result;
    }

    if (existing?.status === "running") {
      return existing.promise;
    }

    const registration = this.registrations.get(input.recoveryKey ?? input.toolName);

    if (!registration) {
      return undefined;
    }

    const promise = this.run(registration, input);
    this.states.set(input.contentIndex, { status: "running", promise });

    const result = await promise;
    this.states.set(input.contentIndex, { status: "done", result });
    return result;
  }

  cancel(contentIndex: number): void {
    this.states.delete(contentIndex);
  }

  cleanup(contentIndex: number): void {
    this.states.delete(contentIndex);
  }

  cleanupAll(): void {
    this.states.clear();
  }

  private async run(
    registration: PartialToolRecoveryRegistration,
    input: PartialToolRecoveryInput,
  ): Promise<PartialToolRecoveryResult> {
    const skippedEntries: RecoverySkippedEntry[] = [];
    const completedEntryIndexes = new Set(input.completedEntryIndexes);
    const blockedEntryIndexes = new Set(input.blockedEntryIndexes);
    const candidates = registration.extractEntries(input);
    const complete = candidates.filter((entry) => {
      if (completedEntryIndexes.has(entry.index)) {
        skippedEntries.push({
          index: entry.index,
          reason: "entry already completed before recovery",
        });
        return false;
      }

      if (blockedEntryIndexes.has(entry.index)) {
        skippedEntries.push({ index: entry.index, reason: "entry was blocked by a guard" });
        return false;
      }

      const isComplete = registration.isCompleteEntry?.(entry, input) ?? entry.complete;

      if (!isComplete) {
        skippedEntries.push({
          index: entry.index,
          reason: input.recoverCompleteBatch
            ? "entry was incomplete in the recovered batch"
            : "entry was incomplete before the stale entry",
        });
      }

      if (
        !input.recoverCompleteBatch &&
        input.staleEntryIndex !== undefined &&
        entry.index >= input.staleEntryIndex
      ) {
        return false;
      }

      return isComplete;
    });
    const selected = registration.filterEntries?.(complete, input) ?? complete;
    const selectedIndexes = new Set(selected.map((entry) => entry.index));

    for (const entry of complete) {
      if (!selectedIndexes.has(entry.index)) {
        skippedEntries.push({
          index: entry.index,
          reason: "entry was excluded by recovery filtering",
        });
      }
    }

    const valid: RecoveryEntry[] = [];

    for (const entry of selected) {
      try {
        registration.validateEntry?.(entry, input);
        valid.push(entry);
      } catch (error) {
        skippedEntries.push({
          index: entry.index,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const base = {
      toolName: input.toolName,
      contentIndex: input.contentIndex,
      ...(input.staleEntryIndex !== undefined && { staleEntryIndex: input.staleEntryIndex }),
      staleDetails: input.staleDetails,
    } as const;

    if (valid.length === 0) {
      return {
        ...base,
        status: "skipped",
        appliedEntries: [],
        skippedEntries,
      };
    }

    try {
      const parameters = registration.buildParams(valid, input);
      const normalResult = await registration.execute(parameters, {
        contentIndex: input.contentIndex,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        cwd: input.cwd,
        ctx: input.ctx,
        signal: new AbortController().signal,
      });

      return {
        ...base,
        status: "recovered",
        appliedEntries:
          registration.getAppliedEntries?.(normalResult, valid, input) ??
          valid.map((entry) => entry.index),
        skippedEntries,
        normalResult,
      };
    } catch (error) {
      return {
        ...base,
        status: "failed",
        appliedEntries: [],
        skippedEntries,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
