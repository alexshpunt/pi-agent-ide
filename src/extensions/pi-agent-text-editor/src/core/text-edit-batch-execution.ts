import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type BatchCallEffect = "not-applied" | "applied" | "unknown";

export type BatchCallExecutionState =
  | "pending"
  | "running"
  | "completed"
  | "failed-not-applied"
  | "failed-applied"
  | "failed-unknown"
  | "blocked";

export interface BatchCallFailure {
  readonly error: unknown;
  readonly effect: BatchCallEffect;
  readonly result?: AgentToolResult<unknown>;
}

export interface BatchCallExecutionEntry {
  readonly callId: string;
  readonly state: BatchCallExecutionState;
  readonly result?: AgentToolResult<unknown>;
  readonly failure?: BatchCallFailure;
  readonly blockedDetails?: unknown;
  readonly recovered: boolean;
  readonly reason?: string;
}

export interface BatchExecutionReporter<TDetails = unknown> {
  start(callId: string): void;
  complete(callId: string, result: AgentToolResult<TDetails>): void;
  fail(callId: string, failure: BatchCallFailure): void;
}

export class BatchExecutionJournal {
  private readonly entries: Map<string, BatchCallExecutionEntry>;

  constructor(callIds: readonly string[]) {
    this.entries = new Map(
      callIds.map((callId) => [callId, { callId, state: "pending", recovered: false }]),
    );
  }

  reporter(recovered = false): BatchExecutionReporter {
    return {
      start: (callId) => {
        this.transition(callId, { state: "running", recovered });
      },
      complete: (callId, result) => {
        this.transition(callId, { state: "completed", result, recovered });
      },
      fail: (callId, failure) => {
        this.transition(callId, {
          state: `failed-${failure.effect}`,
          failure,
          ...(failure.result !== undefined && { result: failure.result }),
          recovered,
        });
      },
    };
  }

  block(callId: string, result: AgentToolResult<unknown>, details?: unknown): void {
    this.transition(callId, {
      state: "blocked",
      result,
      blockedDetails: details,
      recovered: false,
    });
  }

  skip(callId: string, reason: string): void {
    this.transition(callId, {
      state: "failed-not-applied",
      failure: { error: new Error(reason), effect: "not-applied" },
      recovered: false,
      reason,
    });
  }

  markRunningUnknown(error: unknown): void {
    for (const entry of this.entries.values()) {
      if (entry.state === "running") {
        this.transition(entry.callId, {
          state: "failed-unknown",
          failure: { error, effect: "unknown" },
          recovered: entry.recovered,
        });
      }
    }
  }

  get(callId: string): BatchCallExecutionEntry {
    const entry = this.entries.get(callId);

    if (!entry) {
      throw new Error(`Unknown batch call ${callId}.`);
    }

    return entry;
  }

  snapshot(): readonly BatchCallExecutionEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  private transition(callId: string, update: Omit<BatchCallExecutionEntry, "callId">): void {
    if (!this.entries.has(callId)) {
      throw new Error(`Unknown batch call ${callId}.`);
    }

    this.entries.set(callId, { callId, ...update });
  }
}
