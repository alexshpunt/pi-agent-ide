import { requiredValue } from "../../../../utils/required-value.js";
import { BatchExecutionJournal, type BatchExecutionReporter } from "./text-edit-batch-execution.js";

import type { BlockedToolCall, ToolBatchRecoveryDefinition } from "./text-edit-batch-recovery.js";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function isObjectNotArray(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OriginalToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface BatchCallCandidate<TState = unknown> {
  readonly call: OriginalToolCall;
  readonly state: TState;
  readonly renderArgumentPatch?: Readonly<Record<string, unknown>>;
}

export interface ToolBatchDefinition<TState = unknown> {
  readonly sourceTools: readonly string[];
  readonly syntheticTool: string;
  readonly resolveCall: (
    call: OriginalToolCall,
    inheritedState: TState | undefined,
  ) => BatchCallCandidate<TState> | undefined;
  readonly buildArguments: (
    calls: readonly BatchCallCandidate<TState>[],
  ) => Record<string, unknown>;
  readonly execute: (
    toolCallId: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    context: ExtensionContext,
    reporter: BatchExecutionReporter,
  ) => Promise<AgentToolResult<unknown>>;
  readonly splitResult?: (
    aggregate: AgentToolResult<unknown>,
    calls: readonly OriginalToolCall[],
    candidates: readonly BatchCallCandidate<TState>[],
  ) => ReadonlyMap<string, AgentToolResult<unknown>>;
  readonly onRenderArguments?: (
    toolCallId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => void;
  readonly recovery?: ToolBatchRecoveryDefinition<TState>;
}

interface RawToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface CoordinatorState {
  readonly definitions: ToolBatchDefinition[];
  registered: boolean;
  nextBatchId: number;
}

interface BatchExecution {
  readonly aggregate?: AgentToolResult<unknown>;
  readonly perCallResults?: ReadonlyMap<string, AgentToolResult<unknown>>;
}

interface BatchPlan {
  readonly definition: ToolBatchDefinition;
  readonly candidates: readonly BatchCallCandidate[];
  readonly calls: readonly OriginalToolCall[];
  readonly carrierId: string;
  readonly batchId: string;
  readonly remainingCallIds: Set<string>;
  readonly journal: BatchExecutionJournal;
  readonly blockedCalls: BlockedToolCall[];
  execution?: Promise<BatchExecution>;
}

const batchPlans = new Map<string, BatchPlan>();
const coordinators = new WeakMap<object, CoordinatorState>();
const blockedToolCalls = new Map<string, BlockedToolCall>();

export function registerBlockedToolCall(blocked: BlockedToolCall): void {
  blockedToolCalls.set(blocked.callId, blocked);
  const plan = batchPlans.get(blocked.callId);

  if (plan?.blockedCalls.every((item) => item.callId !== blocked.callId)) {
    plan.blockedCalls.push(blocked);
    plan.journal.block(blocked.callId, blocked.result, blocked.details);
  }
}

function clearCoordinatorCalls(): void {
  batchPlans.clear();
  blockedToolCalls.clear();
}

function asRawToolCall(value: unknown): RawToolCall | undefined {
  if (
    !isObjectNotArray(value) ||
    value.type !== "toolCall" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string"
  ) {
    return undefined;
  }

  if (!isObjectNotArray(value.arguments)) {
    return undefined;
  }

  return { id: value.id, name: value.name, arguments: value.arguments };
}

function definitionFor(state: CoordinatorState, name: string): ToolBatchDefinition | undefined {
  return state.definitions.find((definition) => definition.sourceTools.includes(name));
}

function publishRenderArguments(
  definition: ToolBatchDefinition,
  candidate: BatchCallCandidate,
): void {
  if (candidate.renderArgumentPatch !== undefined) {
    definition.onRenderArguments?.(candidate.call.id, candidate.renderArgumentPatch);
  }
}

function rewriteMessage(state: CoordinatorState, message: unknown, createPlans: boolean): unknown {
  if (
    !isObjectNotArray(message) ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return undefined;
  }

  const content = message.content;
  let inheritedDefinition: ToolBatchDefinition | undefined;
  let inheritedState: unknown;

  for (let index = 0; index < content.length;) {
    const first = asRawToolCall(content[index]);
    const definition = first ? definitionFor(state, first.name) : undefined;
    const firstCandidate =
      first && definition
        ? definition.resolveCall(
            first,
            inheritedDefinition === definition ? inheritedState : undefined,
          )
        : undefined;

    if (!definition || !firstCandidate) {
      inheritedDefinition = undefined;
      inheritedState = undefined;
      index += 1;
      continue;
    }

    publishRenderArguments(definition, firstCandidate);

    const run: BatchCallCandidate[] = [firstCandidate];
    let nextIndex = index + 1;

    while (nextIndex < content.length) {
      const next = asRawToolCall(content[nextIndex]);

      if (!next || definitionFor(state, next.name) !== definition) {
        break;
      }

      const candidate = definition.resolveCall(next, requiredValue(run.at(-1)).state);

      if (!candidate) {
        break;
      }

      publishRenderArguments(definition, candidate);
      run.push(candidate);
      nextIndex += 1;
    }

    const last = requiredValue(run.at(-1));

    if (createPlans && run.length >= 2) {
      const calls = run.map(({ call }) => call);
      const journal = new BatchExecutionJournal(calls.map((call) => call.id));
      const blockedCalls = calls.flatMap((call) => {
        const blocked = blockedToolCalls.get(call.id);
        return blocked === undefined ? [] : [blocked];
      });
      const plan: BatchPlan = {
        definition,
        candidates: run,
        calls,
        carrierId: last.call.id,
        batchId: `${String(Date.now())}-${String(state.nextBatchId++)}`,
        remainingCallIds: new Set(calls.map((call) => call.id)),
        journal,
        blockedCalls,
      };

      for (const blocked of blockedCalls) {
        journal.block(blocked.callId, blocked.result, blocked.details);
      }

      for (const call of calls) {
        batchPlans.set(call.id, plan);
      }
    }

    inheritedDefinition = definition;
    inheritedState = last.state;
    index = nextIndex;
  }

  // Keep the assistant message exactly as produced by the model. The batch
  // exists only in the execution plan, never as a persisted synthetic call.
  return undefined;
}

function filterProviderTools(state: CoordinatorState, event: { payload?: unknown }): unknown {
  const payload = event.payload;

  if (!isObjectNotArray(payload) || !Array.isArray(payload.tools)) {
    return undefined;
  }

  const syntheticTools = new Set(state.definitions.map((definition) => definition.syntheticTool));
  return {
    ...payload,
    tools: payload.tools.filter((tool) => {
      if (!isObjectNotArray(tool)) {
        return true;
      }

      const toolName = typeof tool.name === "string" ? tool.name : undefined;
      const functionName =
        isObjectNotArray(tool.function) && typeof tool.function.name === "string"
          ? tool.function.name
          : undefined;

      if (toolName === undefined && functionName === undefined) {
        return true;
      }

      return (
        (toolName === undefined || !syntheticTools.has(toolName)) &&
        (functionName === undefined || !syntheticTools.has(functionName))
      );
    }),
  };
}

interface BatchDisplayCall {
  readonly id: string;
  readonly name: string;
}

function markBatchResult<TDetails>(
  result: AgentToolResult<TDetails>,
  batchId: string,
  calls: readonly BatchDisplayCall[],
): AgentToolResult<TDetails> {
  const details = isObjectNotArray(result.details) ? result.details : {};
  return { ...result, details: { ...details, agenticIdeBatch: { batchId, calls } } as TDetails };
}

function batchDisplayCalls(plan: BatchPlan): BatchDisplayCall[] {
  return plan.calls.map((call) => ({ id: call.id, name: call.name }));
}

function ensureBatchExecution(
  plan: BatchPlan,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  context: ExtensionContext,
): Promise<BatchExecution> {
  plan.execution ??= (async () => {
    let aggregate: AgentToolResult<unknown> | undefined;
    let executionError: unknown;

    try {
      const executable = plan.candidates.filter(
        ({ call }) => plan.journal.get(call.id).state !== "blocked",
      );
      const parameters = plan.definition.buildArguments(executable);
      aggregate = await plan.definition.execute(
        plan.carrierId,
        parameters,
        signal,
        onUpdate,
        context,
        plan.journal.reporter(),
      );
      const split = plan.definition.splitResult?.(aggregate, plan.calls, plan.candidates);

      for (const [callId, result] of split ?? []) {
        if (plan.journal.get(callId).state === "completed") {
          plan.journal.reporter().complete(callId, result);
        }
      }
    } catch (error) {
      executionError = error;
      plan.journal.markRunningUnknown(error);
    }

    await recoverBatch(plan, signal, context);
    const perCallResults = finalBatchResults(plan, executionError);
    return aggregate === undefined ? { perCallResults } : { aggregate, perCallResults };
  })();

  return plan.execution;
}

async function recoverBatch(
  plan: BatchPlan,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<void> {
  const recovery = plan.definition.recovery;

  if (!recovery) {
    return;
  }

  const input = {
    batchId: plan.batchId,
    calls: plan.calls,
    candidates: plan.candidates,
    journal: plan.journal.snapshot(),
    blockedCalls: plan.blockedCalls,
    cwd: context.cwd,
    signal,
    ctx: context,
  };
  const requested = new Set(recovery.select(input));
  const selected = plan.candidates.filter(({ call }) => {
    const state = plan.journal.get(call.id).state;
    return requested.has(call.id) && (state === "pending" || state === "failed-not-applied");
  });

  if (selected.length === 0) {
    return;
  }

  try {
    const outcome = await recovery.execute({
      ...input,
      selected,
      reporter: plan.journal.reporter(true),
    });

    for (const [callId, result] of outcome.results) {
      if (selected.some(({ call }) => call.id === callId)) {
        plan.journal.reporter(true).complete(callId, result);
      } else if (plan.journal.get(callId).state === "completed") {
        plan.journal.reporter().complete(callId, result);
      }
    }

    for (const [callId, reason] of outcome.skipped ?? []) {
      plan.journal.skip(callId, reason);
    }
  } catch (error) {
    for (const { call } of selected) {
      const state = plan.journal.get(call.id).state;

      if (state === "pending" || state === "running" || state === "failed-not-applied") {
        plan.journal.reporter(true).fail(call.id, {
          error,
          effect: state === "running" ? "unknown" : "not-applied",
        });
      }
    }
  }
}

function finalBatchResults(
  plan: BatchPlan,
  executionError: unknown,
): ReadonlyMap<string, AgentToolResult<unknown>> {
  return new Map(
    plan.calls.map((call) => {
      const entry = plan.journal.get(call.id);

      if (entry.result) {
        const details = isObjectNotArray(entry.result.details) ? entry.result.details : {};
        return [
          call.id,
          {
            ...entry.result,
            details: {
              ...details,
              batchRecovery: {
                batchId: plan.batchId,
                state: entry.state,
                recovered: entry.recovered,
                ...(entry.reason !== undefined && { reason: entry.reason }),
              },
            },
          },
        ];
      }

      const cause = entry.failure?.error ?? executionError ?? entry.reason;
      const message =
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "call did not execute";
      return [
        call.id,
        {
          content: [{ type: "text" as const, text: `${call.name} failed: ${message}` }],
          details: {
            batchRecovery: {
              batchId: plan.batchId,
              state: entry.state,
              recovered: entry.recovered,
              ...(entry.reason !== undefined && { reason: entry.reason }),
            },
          },
          isError: true,
        },
      ];
    }),
  );
}

function releaseBatchCall(plan: BatchPlan, toolCallId: string): void {
  plan.remainingCallIds.delete(toolCallId);

  if (plan.remainingCallIds.size > 0) {
    return;
  }

  for (const call of plan.calls) {
    batchPlans.delete(call.id);
    blockedToolCalls.delete(call.id);
  }
}

/**
Execute a planned batch once and return the result belonging to this call.
*/
export async function executeWithBatchCoordinator<TDetails>(
  toolCallId: string,
  directExecute: () => Promise<AgentToolResult<TDetails>>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  context: ExtensionContext,
): Promise<AgentToolResult<TDetails>> {
  const plan = batchPlans.get(toolCallId);

  if (!plan) {
    return directExecute();
  }

  try {
    if (plan.definition.splitResult === undefined && plan.carrierId !== toolCallId) {
      return {
        content: [{ type: "text", text: "" }],
        details: { agenticIdeBatchSuppressed: true },
      } as AgentToolResult<TDetails>;
    }

    const execution = await ensureBatchExecution(
      plan,
      signal,
      onUpdate as AgentToolUpdateCallback<unknown> | undefined,
      context,
    );

    if (plan.definition.splitResult !== undefined) {
      const result = execution.perCallResults?.get(toolCallId);

      if (!result) {
        throw new Error(`Missing split batch result for tool call ${toolCallId}.`);
      }

      return markBatchResult(
        result as AgentToolResult<TDetails>,
        plan.batchId,
        batchDisplayCalls(plan),
      );
    }

    if (!execution.aggregate) {
      return await directExecute();
    }

    return execution.aggregate as AgentToolResult<TDetails>;
  } finally {
    releaseBatchCall(plan, toolCallId);
  }
}

/**
Get or create the coordinator state for one extension instance.
*/
function coordinatorFor(pi: ExtensionAPI): CoordinatorState {
  let state = coordinators.get(pi);

  if (!state) {
    const created: CoordinatorState = {
      definitions: [],
      registered: false,
      nextBatchId: 1,
    };
    coordinators.set(pi, created);
    state = created;
  }

  if (!state.registered) {
    state.registered = true;
    pi.on("message_update", (event) => {
      rewriteMessage(state, event.message, false);
      return;
    });
    pi.on("message_end", (event) => {
      rewriteMessage(state, event.message, true);
      return;
    });
    pi.on("before_provider_request", (event) => filterProviderTools(state, event));
    pi.on("agent_end", () => {
      clearCoordinatorCalls();
    });
  }

  return state;
}

/**
Register one batch family with the coordinator.
*/
export function registerToolBatch<TState>(
  pi: ExtensionAPI,
  definition: ToolBatchDefinition<TState>,
): void {
  const state = coordinatorFor(pi);
  const definitionForCoordinator: ToolBatchDefinition = {
    sourceTools: definition.sourceTools,
    syntheticTool: definition.syntheticTool,
    resolveCall: (call, inheritedState) =>
      definition.resolveCall(call, inheritedState as TState | undefined),
    buildArguments: (calls) =>
      definition.buildArguments(calls as readonly BatchCallCandidate<TState>[]),
    execute: definition.execute,
    ...(definition.onRenderArguments !== undefined && {
      onRenderArguments: definition.onRenderArguments,
    }),
    ...(definition.recovery !== undefined && { recovery: definition.recovery }),
    ...(definition.splitResult !== undefined && {
      splitResult: (aggregate, calls, candidates) =>
        requiredValue(definition.splitResult)(
          aggregate,
          calls,
          candidates as readonly BatchCallCandidate<TState>[],
        ),
    }),
  };
  state.definitions.push(definitionForCoordinator);
}
