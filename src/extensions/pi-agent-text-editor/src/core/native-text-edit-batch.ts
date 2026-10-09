import { readFile } from "node:fs/promises";
import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AnyTextMutationToolRegistration } from "#src/api/mutation-tool.js";
import { getLastResolvedResource } from "#src/api/last-resolved-resource.js";
import { isMutationAnchorValue } from "#src/api/mutation-tool.js";
import type { FileMutationBatchResult, FileMutationResult } from "#src/api/mutation-result.js";
import type { TextBatchEntry } from "./text-edit-batch.js";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import type { TextEditorCore, TextResourceEditRequest } from "./text-editor-core.js";
import { BatchExecutionJournal } from "./text-edit-batch-execution.js";
import {
  executeRegisteredTextBatch,
  planRegisteredTextBatch,
  type PlannedTextBatch,
} from "./text-edit-batch-registrar.js";
import { buildFailedTextMutationResult, mutationSources } from "./text-mutation.js";
import { isWholeFileInvocation } from "./file-operation-tools.js";
import { isResultInput } from "./result-transfer.js";
import { FileMutationAgentResult } from "./mutation-result/file-mutation-agent-result.js";
import { writeProblemNotices } from "./write-agent-result.js";
import {
  ResourceScheduler,
  resourceAccesses,
  connectResultTargets,
  resultError,
  type ResultTargetStore,
  type StructuredResult,
} from "pi-agent-resource";
import { createPostEditScope } from "./post-edit-scope.js";
import { committedMutationTargets, unchangedCopySources } from "./mutation-result-targets.js";
import { FileMutationResult as MutationPresentation } from "./mutation-result/file-mutation-result.js";
import { isFormattingContribution, isDiffStatusContribution } from "#src/api/post-edit.js";
import { captureScriptMutation } from "./text-mutation.js";
import {
  NATIVE_EDIT_BATCH_EVENT,
  type NativeEditBatchEvent,
} from "#src/api/native-edit-batch-event.js";
import { mutationOutcome, type MutationData, type BatchMutationData } from "./structured-result.js";

/** A confirmed whole-file write can finish formatting after its child tool has returned. */
function appliedFileAction(
  result: AgentToolResult<FileMutationBatchResult>,
): Record<string, unknown> | undefined {
  const action = result.details.metadata?.semanticAction;
  if (
    action === null ||
    typeof action !== "object" ||
    !("effect" in action) ||
    action.effect !== "applied"
  )
    return undefined;
  return action;
}

interface PendingBatch {
  readonly entries: TextBatchEntry[];
  readonly snapshots: Map<string, string>;
  readonly existence: Map<string, boolean>;
  readonly requests: Map<string, TextResourceEditRequest>;
  plan: PlannedTextBatch;
}

interface BatchSummary {
  readonly calls: readonly { readonly id: string; readonly state: string }[];
  readonly applied: boolean;
}

interface ScriptBatch {
  readonly reports: StructuredResult<BatchMutationData>[];
  readonly id: string;
  readonly context: ExtensionContext;
  readonly summaries: BatchSummary[];
  readonly results: FileMutationResult[];
  readonly completedWrites: Set<FileMutationResult>;
  readonly presentations: NativeEditBatchEvent[];
  readonly errors: string[];
  readonly cancellation: AbortController;
  readonly targets: Map<string, string>;
  readonly postEdits: ReturnType<typeof createPostEditScope>;
  tail: Promise<void>;
  readonly scheduler: ResourceScheduler;
  readonly callOrder: Map<string, number>;
  readonly unfinishedCalls: Map<string, string>;
  pending: PendingBatch;
  closed: boolean;
}

function completedWriteNotices(result: FileMutationResult): string[] {
  return writeProblemNotices([result]).map((notice) => `${result.path ?? "Write"}: ${notice}`);
}
function replaceScriptResult(
  script: ScriptBatch,
  previous: FileMutationResult,
  updated: FileMutationResult,
): void {
  const index = script.results.indexOf(previous);
  if (index >= 0) script.results[index] = updated;
  if (script.completedWrites.delete(previous)) script.completedWrites.add(updated);
  for (const [slot, presentation] of script.presentations.entries()) {
    const results = presentation.result.details.results;
    if (!results?.includes(previous)) continue;
    script.presentations[slot] = {
      ...presentation,
      result: {
        ...presentation.result,
        details: {
          ...presentation.result.details,
          results: results.map((result) => (result === previous ? updated : result)),
        },
      },
    };
  }
}
function mergedFiles(files: MutationData["files"]): MutationData["files"] {
  const merged = new Map<string, MutationData["files"][number]>();
  for (const file of files) {
    const previous = merged.get(file.source);
    const effect =
      previous?.effect === "unknown" || file.effect === "unknown"
        ? "unknown"
        : previous?.effect === "applied" || file.effect === "applied"
          ? "applied"
          : file.effect;
    merged.set(file.source, { ...file, effect });
  }
  return [...merged.values()];
}

function receiptEffect(files: MutationData["files"]): MutationData["effect"] {
  return files.some((file) => file.effect === "unknown")
    ? "unknown"
    : files.some((file) => file.effect === "applied")
      ? "applied"
      : "not-applied";
}

function receiptStatus(errors: readonly unknown[], operations: BatchMutationData["operations"]) {
  return errors.length === 0
    ? ("success" as const)
    : operations.some(
          (operation) => operation.effect === "applied" && operation.errors.length === 0,
        ) &&
        operations.some(
          (operation) => operation.errors.length > 0 || operation.effect !== "applied",
        )
      ? ("partial" as const)
      : ("error" as const);
}

function assertOpen(script: ScriptBatch): void {
  if (script.closed) throw new Error("Codemode editor batch is closed.");
}
function pendingBatch(): PendingBatch {
  return {
    entries: [],
    snapshots: new Map(),
    existence: new Map(),
    requests: new Map(),
    plan: { changes: new Map(), mutations: [], failures: [] },
  };
}

function isBatchable(
  core: TextEditorCore,
  registration: AnyTextMutationToolRegistration,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (
    registration.name === "write" ||
    registration.direct?.matches(input) ||
    registration.intent === "restore" ||
    isWholeFileInvocation(registration.wholeFileOperation, input) ||
    core.getSemanticMutationHandler(registration.name, input)
  )
    return false;
  const fields = [
    registration.source.field,
    ...(registration.source.targets ?? []).map((target) => target.field),
    ...(registration.anchors ?? []).map((anchor) => anchor.field),
  ];
  return (
    fields.every((field) => {
      const value = input[field];
      return (
        typeof value !== "string" ||
        !/^[a-z][a-z\d+.-]+:/iu.test(value) ||
        value.startsWith("file://")
      );
    }) &&
    typeof input[registration.source.field] === "string" &&
    String(input[registration.source.field]).length > 0
  );
}

class NativeTextEditBatchCoordinator {
  private readonly scripts = new Map<string, ScriptBatch>();
  private readonly invocations = new Map<string, ScriptBatch>();
  private readonly scopedInvocations = new Map<string, ScriptBatch>();
  private readonly resultTargets: ResultTargetStore;

  constructor(
    private readonly core: TextEditorCore,
    private readonly pi: ExtensionAPI,
  ) {
    this.resultTargets = connectResultTargets(pi);
    pi.on("tool_call", async (event, context) => {
      if (event.toolName === "codemode" && event.parentToolCallId === undefined) {
        this.scripts.set(event.toolCallId, {
          id: event.toolCallId,
          context,
          summaries: [],
          reports: [],
          presentations: [],
          results: [],
          completedWrites: new Set(),
          errors: [],
          cancellation: new AbortController(),
          targets: new Map(),
          postEdits: createPostEditScope(context.cwd),
          tail: Promise.resolve(),
          scheduler: new ResourceScheduler(),
          callOrder: new Map(),
          unfinishedCalls: new Map(),
          pending: pendingBatch(),
          closed: false,
        });
        return;
      }
      const script =
        event.parentToolCallId === undefined ? undefined : this.scripts.get(event.parentToolCallId);
      if (!script) return;
      const registration = this.core
        .getMutationTools()
        .find((tool) => tool.name === event.toolName);
      const input: Record<string, unknown> = event.input;
      if (registration) {
        this.scopedInvocations.set(event.toolCallId, script);
        const source = input[registration.source.field];
        script.unfinishedCalls.set(
          event.toolCallId,
          typeof source === "string" && !isResultInput(source) ? source : "",
        );
      }
      let ownsSource = false;
      if (registration && !isWholeFileInvocation(registration.wholeFileOperation, input)) {
        const resolverContext = {
          cwd: context.cwd,
          ...(context.signal !== undefined && { signal: context.signal }),
        };
        for (const descriptor of [registration.source, ...(registration.source.targets ?? [])]) {
          const value = input[descriptor.field];
          if (typeof value === "string" && value.length > 0) {
            if (
              ["replace", "write", "copy", "move", "delete", "undo", "insert"].includes(
                registration.name,
              ) &&
              value.startsWith("RESULT#")
            ) {
              // The executor validates result handles and returns a structured rejection.
              ownsSource = true;
              continue;
            }
            const result = await this.core.textTargetResolver().tryResolve(value, resolverContext);
            if (result.kind !== "not-handled") ownsSource = true;
          }
        }
        for (const anchor of registration.anchors ?? []) {
          const value = input[anchor.field];
          if (
            isMutationAnchorValue(anchor, value) &&
            (await this.core.resolveTextAnchorResources(value, anchor.kinds, resolverContext)) !==
              undefined
          )
            ownsSource = true;
        }
        if (registration.source.inherited && !input[registration.source.field] && !ownsSource) {
          const source = script.pending.entries.at(-1)?.path ?? getLastResolvedResource(pi)?.source;
          if (source !== undefined) input[registration.source.field] = source;
        }
      }
      if (
        registration &&
        !ownsSource &&
        !script.context.cwd.startsWith("ssh://") &&
        isBatchable(this.core, registration, input)
      ) {
        this.invocations.set(event.toolCallId, script);
        return;
      }
      const work = script.scheduler.run(undefined, () => this.commit(script));
      script.tail = work.then(
        () => undefined,
        () => undefined,
      );
      if (!(await work))
        return {
          block: true,
          reason:
            "Editor batch failed before this tool. See the Codemode result; do not replay accepted edits automatically.",
        };
      return;
    });
    pi.on("tool_result", async (event) => {
      this.scopedInvocations.get(event.toolCallId)?.unfinishedCalls.delete(event.toolCallId);
      this.invocations.delete(event.toolCallId);
      this.scopedInvocations.delete(event.toolCallId);
      const script = this.scripts.get(event.toolCallId);
      if (!script) return;
      script.closed = true;
      const texts = event.content
        .filter((block) => block.type === "text")
        .map((block) => block.text);
      let executionError =
        texts
          .join("\n")
          .match(
            /(?:^|\n)(Script error:\nScript (?:aborted|timed out):[^\n]*\n\n(?:Tool calls made before the failure[^\n]*|No tool calls were made\.))(?![\s\S]*\nScript error:\n)/u,
          )?.[1] ?? "";
      const executionDetails = event.details;
      if (
        event.isError &&
        executionDetails !== null &&
        typeof executionDetails === "object" &&
        "fullOutputPath" in executionDetails &&
        typeof executionDetails.fullOutputPath === "string"
      ) {
        try {
          const output = await readFile(executionDetails.fullOutputPath, "utf8");
          // A timeout has one engine error line followed by the call summary, not a JavaScript stack.
          const matches = [
            ...output.matchAll(
              /(?:^|\n)(Script error:\nScript (?:aborted|timed out):[^\n]*\n\n(?:Tool calls made before the failure[^\n]*|No tool calls were made\.))/gu,
            ),
          ];
          const match = matches.at(-1);
          executionError =
            match !== undefined &&
            !output.slice(match.index + match[0].length).includes("Script error:\n")
              ? (match[1] ?? "")
              : "";
        } catch {
          // Use the returned output when its complete artifact is unavailable.
        }
      }
      const interrupted =
        script.context.signal?.aborted ||
        (event.isError && /^Script error:\nScript (?:aborted|timed out):/u.test(executionError));
      if (interrupted) script.cancellation.abort();
      await script.tail;
      if (interrupted) {
        if (script.pending.entries.length > 0) {
          const error = resultError(
            "The operation was interrupted before writing. No file was changed.",
            "CANCELLED",
          );
          const operations = script.pending.entries.map((entry) => ({
            id: entry.callId,
            operation: entry.op,
            effect: "not-applied" as const,
            errors: [error],
          }));
          script.reports.push({
            status: "error",
            errors: [error],
            data: {
              operation: "batch",
              effect: "not-applied",
              operations,
              files: [...script.pending.snapshots.keys()].map((source) => ({
                source,
                effect: "not-applied",
              })),
            },
          });
          script.errors.push(error.message);
          for (const entry of script.pending.entries) {
            const target = script.targets.get(entry.callId);
            if (target) this.resultTargets.reject(target, error.message);
          }
          script.pending = pendingBatch();
        }
      } else await this.commit(script);
      if (interrupted) {
        for (const [id, source] of script.unfinishedCalls) {
          if (
            script.presentations.some((presentation) => presentation.calls.includes(id)) ||
            script.reports.some((report) =>
              report.data?.operations.some((operation) => operation.id === id),
            )
          )
            continue;
          // Cancellation is not a result. Do not guess whether a resolver already wrote.
          const message =
            "The operation was interrupted. Its file effects are unknown.\nRead the affected files before retrying.";
          const presentation = new MutationPresentation({
            ok: false,
            path: source,
            fileChangedStatement: message,
            errors: [{ path: source, code: "CANCELLED" }],
          });
          const result: AgentToolResult<FileMutationBatchResult> = {
            content: [new FileMutationAgentResult(presentation).toTextContent()],
            details: { results: [presentation], effect: "unknown" },
            isError: true,
          };
          script.results.push(presentation);
          script.presentations.push({ parentToolCallId: script.id, calls: [id], result });
        }
      }
      try {
        await this.core.enqueueFileOperation(
          () =>
            script.postEdits.finish(
              (outcome) => {
                const index = script.results.findLastIndex(
                  (item) => item.data.path === outcome.after.source,
                );
                if (index < 0) {
                  const statuses = outcome.postEditContributions
                    .map((item) => item.data)
                    .filter(isDiffStatusContribution)
                    .flatMap((item) => item.diffStatuses);
                  let recorded = false;
                  for (const [slot, presentation] of script.presentations.entries()) {
                    const action = appliedFileAction(presentation.result);
                    if (action?.target !== outcome.after.source) continue;
                    recorded = true;
                    script.presentations[slot] = {
                      ...presentation,
                      result: {
                        ...presentation.result,
                        details: {
                          ...presentation.result.details,
                          metadata: {
                            ...presentation.result.details.metadata,
                            semanticAction: { ...action, diffStatuses: statuses },
                          },
                        },
                      },
                    };
                  }
                  if (recorded && statuses.length > 0)
                    script.results.push(
                      new MutationPresentation({
                        ok: true,
                        path: outcome.after.source,
                        files: [{ path: outcome.after.source, action: "edited" }],
                        diffStatuses: statuses,
                        formatting: outcome.postEditContributions
                          .map((item) => item.data)
                          .findLast(isFormattingContribution)?.formatting ?? {
                          status: "not-reported",
                        },
                      }),
                    );
                  return;
                }
                const previous = requiredValue(script.results[index]).data;
                const updated = new MutationPresentation({
                  ...previous,
                  afterContent: outcome.after.content,
                  afterDocument: outcome.after,
                  formatting: outcome.postEditContributions
                    .map((item) => item.data)
                    .findLast(isFormattingContribution)?.formatting ?? { status: "not-reported" },
                  diffStatuses: outcome.postEditContributions
                    .map((item) => item.data)
                    .filter(isDiffStatusContribution)
                    .flatMap((item) => item.diffStatuses),
                });
                replaceScriptResult(script, requiredValue(script.results[index]), updated);
              },
              (source, error) => {
                const reason = error instanceof Error ? error.message : String(error);
                const failure = { code: "POST_EDIT_FAILED", message: reason, source };
                for (const previous of script.results.filter(
                  (result) => result.data.path === source,
                )) {
                  replaceScriptResult(
                    script,
                    previous,
                    new MutationPresentation({
                      ok: false,
                      path: source,
                      errors: [{ path: source, code: failure.code, reason }],
                      fileChangedStatement:
                        "The edit was saved, but final processing failed. Final text is not confirmed. Run Read/Search before editing this resource again.",
                    }),
                  );
                }
                for (const [index, report] of script.reports.entries()) {
                  if (!report.data?.files.some((file) => file.source === source)) continue;
                  script.reports[index] = {
                    ...report,
                    status: report.status === "success" ? "partial" : report.status,
                    errors: [...report.errors, failure],
                  };
                }
              },
            ),
          undefined,
          { cwd: script.context.cwd, sources: script.postEdits.sources() },
        );
      } catch (error) {
        script.errors.push(error instanceof Error ? error.message : String(error));
      }
      // Nested panels are frozen on message_end. Publish final snapshots before history is saved.
      for (const presentation of script.presentations) {
        const results = presentation.result.details.results ?? [];
        this.pi.events.emit(NATIVE_EDIT_BATCH_EVENT, {
          ...presentation,
          result: {
            ...presentation.result,
            content: [new FileMutationAgentResult(results).toTextContent()],
          },
        } satisfies NativeEditBatchEvent);
      }
      this.scripts.delete(event.toolCallId);
      // Write already returned its compact receipt to the script. Keep full user panels,
      // but do not append their file text outside explicit script output.
      const parentResults = script.results.filter(
        (result) => !result.ok || !script.completedWrites.has(result),
      );
      if (
        script.results.length === 0 &&
        script.summaries.length === 0 &&
        script.errors.length === 0
      )
        return;
      const failed = script.errors.length > 0;
      const content = event.content.map((block) =>
        failed && block.type === "text"
          ? { ...block, text: block.text.replace(/^Script completed\n/u, "Script failed\n") }
          : block,
      );
      if (script.summaries.length > 0 || failed)
        content.push({
          type: "text",
          text: `Editor batches: ${script.summaries.filter((batch) => batch.applied).length} committed.${failed ? "\n" + script.errors.join("\n") : ""}`,
        });
      const writeNotices = script.results
        .filter((result) => result.ok && script.completedWrites.has(result))
        .flatMap(completedWriteNotices);
      if (writeNotices.length > 0) content.push({ type: "text", text: writeNotices.join("\n") });
      if (parentResults.length > 0)
        content.push(new FileMutationAgentResult(parentResults).toTextContent());
      const details =
        typeof event.details === "object" && event.details !== null ? event.details : {};
      return {
        content,
        details: {
          ...details,
          editorBatches: script.summaries,
          editorBatchResults: script.reports,
        },
        ...(event.structuredContent === undefined
          ? {}
          : { structuredContent: event.structuredContent }),
        isError: event.isError || failed,
      };
    });
    const clear = () => {
      for (const script of this.scripts.values()) {
        script.closed = true;
        script.cancellation.abort();
      }
      this.scripts.clear();
      this.invocations.clear();
      this.scopedInvocations.clear();
    };
    pi.on("agent_end", clear);
    pi.on("session_shutdown", clear);
  }

  /** Share post-edit state while allowing Write to finish its own processing immediately. */
  runPostEdits<T>(id: string, work: () => T, immediate: boolean): T {
    const script = this.scopedInvocations.get(id);
    return script ? script.postEdits.run(work, immediate) : work();
  }

  /** Include applied, non-batched mutations in the script's final post-edit presentation. */
  recordMutation(
    id: string,
    toolName: string,
    result: AgentToolResult<FileMutationBatchResult>,
  ): void {
    const script = this.scopedInvocations.get(id);
    if (script && !script.closed) script.unfinishedCalls.delete(id);
    if (
      !script ||
      script.closed ||
      result.details.effect === "not-applied" ||
      (!result.details.results?.some((item) => item.data.ok === true) &&
        appliedFileAction(result) === undefined)
    )
      return;
    const results = result.details.results ?? [];
    script.results.push(...results);
    if (toolName === "write") for (const item of results) script.completedWrites.add(item);
    script.presentations.push({ parentToolCallId: script.id, calls: [id], result });
  }
  execute(
    id: string,
    registration: AnyTextMutationToolRegistration,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<FileMutationBatchResult>> | undefined {
    const script = this.invocations.get(id);
    if (!script) return undefined;
    script.callOrder.set(id, script.callOrder.size);
    const sources = [...mutationSources(registration, input).values()].map((source) =>
      source.startsWith("file://")
        ? fileURLToPath(source)
        : path.resolve(context.cwd, source.startsWith("@") ? source.slice(1) : source),
    );
    const effectiveSignal =
      signal === undefined
        ? script.cancellation.signal
        : AbortSignal.any([signal, script.cancellation.signal]);
    const work = script.scheduler.run(
      Promise.all(sources.map((source) => resourceAccesses(source, context.cwd, "write"))).then(
        (sets) => sets.flat(),
      ),
      () => this.accept(script, id, registration, input, effectiveSignal, context),
      effectiveSignal,
    );
    script.tail = Promise.allSettled([script.tail, work]).then(() => undefined);
    return work;
  }

  private async accept(
    script: ScriptBatch,
    id: string,
    registration: AnyTextMutationToolRegistration,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<FileMutationBatchResult>> {
    signal?.throwIfAborted();
    assertOpen(script);
    const normalized = { ...input };
    for (const descriptor of [registration.source, ...(registration.source.targets ?? [])]) {
      const source = normalized[descriptor.field];
      if (typeof source === "string" && source.length > 0)
        normalized[descriptor.field] = source.startsWith("file://")
          ? fileURLToPath(source)
          : path.resolve(context.cwd, source.startsWith("@") ? source.slice(1) : source);
    }
    const entry: TextBatchEntry = {
      ...normalized,
      callId: id,
      op: registration.name,
      path: String(normalized[registration.source.field]),
    };
    const batch = script.pending;
    const requests = new Map<string, TextResourceEditRequest>();
    for (const source of mutationSources(registration, entry).values())
      requests.set(source, {
        source,
        read: true,
        ...(registration.name === "write" && { allowReadFailure: true }),
        ...(batch.existence.has(source) && { expectedExistence: batch.existence.get(source) }),
      });
    const planning: { plan?: PlannedTextBatch; cause?: unknown } = {};
    const preview = await this.core.previewTexts(
      [...requests.values()],
      { cwd: context.cwd, ...(signal !== undefined && { signal }) },
      async (texts, resolveAnchor) => {
        try {
          for (const [source, expected] of batch.snapshots)
            if (requests.has(source) && texts.get(source) !== expected)
              throw new Error(`Snapshot source ${source} changed before the edit batch.`);
          planning.plan = await planRegisteredTextBatch(
            new Map([[registration.name, registration]]),
            { edits: [entry], failureMode: "abort" },
            texts,
            resolveAnchor,
            context,
            signal,
            () => {},
            new Map([...batch.plan.changes].filter(([source]) => requests.has(source))),
          );
          return { changes: planning.plan.changes, result: planning.plan };
        } catch (error) {
          planning.cause = error;
          throw error;
        }
      },
    );
    if (preview.kind === "failed") {
      const result = await buildFailedTextMutationResult(
        this.core,
        {
          code: "INVALID_REQUEST",
          source: entry.path,
          message: preview.reason,
          cause: planning.cause,
        },
        context,
      );
      return { ...result, isError: true };
    }
    signal?.throwIfAborted();
    assertOpen(script);
    if (!planning.plan) throw new Error("Editor batch planning did not complete.");
    for (const resource of preview.resources) {
      batch.snapshots.set(resource.path, resource.beforeContent);
      batch.existence.set(resource.path, resource.existed ?? true);
    }
    for (const [source, request] of requests) batch.requests.set(source, request);
    batch.entries.push(entry);
    const order = (left: { callId: string }, right: { callId: string }) =>
      requiredValue(script.callOrder.get(left.callId)) -
      requiredValue(script.callOrder.get(right.callId));
    batch.entries.sort(order);
    batch.plan = {
      changes: new Map([...batch.plan.changes, ...planning.plan.changes]),
      mutations: [...batch.plan.mutations, ...planning.plan.mutations].sort(order),
      failures: [...batch.plan.failures, ...planning.plan.failures],
    };
    const target = ["replace", "insert", "write", "copy", "move"].includes(registration.name)
      ? this.resultTargets.reserve(context.cwd)
      : undefined;
    if (target) script.targets.set(id, target);
    const unchangedCopy =
      registration.name === "copy" &&
      planning.plan.mutations.every(
        ({ mutation }) =>
          mutation.edits.size > 0 &&
          unchangedCopySources(mutation, batch.snapshots).size === mutation.edits.size,
      );
    const details = {
      results: [],
      source: entry.path,
      resolvedBy: preview.resources.find((resource) => resource.path === entry.path)?.resolvedBy,
      nativeEditBatch: { parentToolCallId: script.id, state: "accepted" },
      ...(target ? { metadata: { resultTarget: target } } : {}),
    };
    return {
      content: [
        {
          type: "text",
          text:
            registration.name === "copy"
              ? unchangedCopy
                ? "No changes: destination already has this text."
                : `Copy destination: ${typeof normalized.target === "string" ? normalized.target : entry.path}`
              : `Accepted ${registration.name} for ${entry.path}. Check the final Codemode result for applied changes.`,
        },
      ],
      details,
    };
  }

  private async settleTargets(
    script: ScriptBatch,
    batch: PendingBatch,
    journal: BatchExecutionJournal,
    completions: readonly TextEditCompletion[],
    signal: AbortSignal,
  ): Promise<void> {
    let mapped: ReturnType<typeof committedMutationTargets>;
    try {
      mapped = committedMutationTargets(
        batch.plan.mutations.map(({ callId, mutation }) => ({ callId, edits: mutation.edits })),
        completions,
        batch.snapshots,
      );
    } catch (error) {
      for (const entry of batch.entries) {
        const target = script.targets.get(entry.callId);
        if (target)
          this.resultTargets.reject(target, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const calls = journal.snapshot();
    for (const entry of batch.entries) {
      const reference = script.targets.get(entry.callId);
      if (!reference) continue;
      const targets = mapped.get(entry.callId);
      if (calls.find((call) => call.callId === entry.callId)?.state !== "completed" || !targets) {
        this.resultTargets.reject(
          reference,
          "This operation did not produce confirmed filesystem targets.",
        );
        continue;
      }
      try {
        await this.resultTargets.verify({ targets, complete: true }, signal);
        this.resultTargets.confirm(reference, targets, script.context.cwd);
      } catch (error) {
        this.resultTargets.reject(
          reference,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async commit(script: ScriptBatch): Promise<boolean> {
    const batch = script.pending;
    if (batch.entries.length === 0) return true;
    script.pending = pendingBatch();
    const journal = new BatchExecutionJournal(batch.entries.map((entry) => entry.callId));
    const registrations = new Map(this.core.getMutationTools().map((tool) => [tool.name, tool]));
    const signal =
      script.context.signal === undefined
        ? script.cancellation.signal
        : AbortSignal.any([script.context.signal, script.cancellation.signal]);
    const unchangedCopies = new Map(
      batch.plan.mutations
        .filter(({ mutation }) => mutation.operation === "copy")
        .map(({ callId, mutation }) => {
          const sources = unchangedCopySources(mutation, batch.snapshots);
          return [
            callId,
            { sources, all: sources.size > 0 && sources.size === mutation.edits.size },
          ] as const;
        }),
    );
    let observedSources: string[] = [];
    const record = (
      outcome: StructuredResult<MutationData>,
      results: readonly FileMutationResult[] = [],
    ): boolean => {
      // Only explicit rollback evidence overrides the journal's call-wide effect.
      const reportedFiles = new Map<string, MutationData["files"][number]>(
        results.flatMap(({ data }) => [
          ...(data.rollback?.restoredSources ?? []).map(
            (source) => [source, { source, effect: "not-applied" as const }] as const,
          ),
          ...(data.rollback?.failedSources ?? []).map(
            (source) => [source, { source, effect: "unknown" as const }] as const,
          ),
        ]),
      );
      const calls = journal.snapshot();
      const operations = calls.map((call) => ({
        id: call.callId,
        operation: requiredValue(batch.entries.find((entry) => entry.callId === call.callId)).op,
        effect:
          call.state === "completed" && unchangedCopies.get(call.callId)?.all
            ? ("not-applied" as const)
            : call.state === "completed" || call.state === "failed-applied"
              ? ("applied" as const)
              : call.state === "failed-unknown" || call.state === "running"
                ? ("unknown" as const)
                : ("not-applied" as const),
        errors: call.failure === undefined ? [] : [resultError(call.failure.error)],
      }));
      const files = mergedFiles([
        ...operations.flatMap((operation) => {
          const entry = requiredValue(batch.entries.find((entry) => entry.callId === operation.id));
          const registration = requiredValue(registrations.get(entry.op));
          const mutation = batch.plan.mutations.find(
            (item) => item.callId === operation.id,
          )?.mutation;
          return [...mutationSources(registration, entry).values()].map((source) => ({
            source,
            effect:
              mutation?.edits.has(source) === false ||
              unchangedCopies.get(operation.id)?.sources.has(source) === true
                ? ("not-applied" as const)
                : operation.effect,
          }));
        }),
        ...observedSources.map((source) => ({ source, effect: "applied" as const })),
      ]).map((file) =>
        observedSources.includes(file.source)
          ? { ...file, effect: "applied" as const }
          : (reportedFiles.get(file.source) ?? file),
      );
      const errors = [
        ...new Map(
          [...outcome.errors, ...operations.flatMap((operation) => operation.errors)].map(
            (error) => [JSON.stringify(error), error],
          ),
        ).values(),
      ];
      const completed = calls.every((call) => call.state === "completed");
      if (!completed && errors.length === 0)
        errors.push(resultError("Editor batch did not complete", "BATCH_FAILED"));
      script.reports.push({
        status: receiptStatus(errors, operations),
        errors,
        data: {
          ...outcome.data,
          operation: "batch",
          effect: receiptEffect(files),
          files,
          operations,
        },
      });
      script.summaries.push({
        calls: calls.map((call) => ({ id: call.callId, state: call.state })),
        applied:
          operations.some((operation) => operation.effect === "applied") ||
          observedSources.length > 0,
      });
      if (!completed)
        script.errors.push(
          "Editor batch failed; inspect its final file results. Accepted edits were not replayed.",
        );
      return completed;
    };
    try {
      signal.throwIfAborted();
      const captured = await script.postEdits.run(() =>
        captureScriptMutation(this.core, () =>
          executeRegisteredTextBatch(
            this.core,
            registrations,
            {
              edits: batch.entries,
              expectedContent: batch.snapshots,
              expectedExistence: batch.existence,
            },
            signal,
            undefined,
            script.context,
            journal.reporter(),
            () => {},
            batch.plan,
          ),
        ),
      );
      observedSources = captured.completions.map((completion) => completion.resourceSource);
      if (captured.kind === "failed") throw captured.error;
      const value =
        captured.completions.length === 0 &&
        journal
          .snapshot()
          .every((call) => call.state === "completed" && unchangedCopies.get(call.callId)?.all)
          ? {
              ...captured.value,
              content: [
                { type: "text" as const, text: "No changes: destination already has this text." },
              ],
              details: { ...captured.value.details, effect: "not-applied" as const },
            }
          : captured.value;
      script.results.push(...(value.details.results ?? []));
      await this.settleTargets(script, batch, journal, captured.completions, signal);
      const presentation = {
        parentToolCallId: script.id,
        calls: batch.entries.map((entry) => entry.callId),
        unchangedCopyCalls: journal
          .snapshot()
          .filter((call) => call.state === "completed" && unchangedCopies.get(call.callId)?.all)
          .map((call) => call.callId),
        ...(value.details.copyResults === undefined
          ? {}
          : { copyResults: value.details.copyResults }),
        result: value,
      } satisfies NativeEditBatchEvent;
      script.presentations.push(presentation);
      this.pi.events.emit(NATIVE_EDIT_BATCH_EVENT, presentation);
      return record(
        mutationOutcome(value, "batch", captured.completions),
        value.details.results ?? [],
      );
    } catch (error) {
      journal.markRunningUnknown(error);
      await this.settleTargets(script, batch, journal, [], signal);
      return record({ status: "error", errors: [resultError(error)] });
    }
  }
}

const coordinators = new WeakMap<TextEditorCore, NativeTextEditBatchCoordinator>();

/** Share deferred post-edit state, or finish this operation's processing before return. */
export function runNativePostEditScope<T>(
  core: TextEditorCore,
  id: string,
  work: () => T,
  immediate = false,
): T {
  const coordinator = coordinators.get(core);
  return coordinator ? coordinator.runPostEdits(id, work, immediate) : work();
}

/** Retain immediate child results for final user panels and deferred processing failures. */
export function recordNativeTextMutation(
  core: TextEditorCore,
  id: string,
  toolName: string,
  result: AgentToolResult<FileMutationBatchResult>,
): void {
  coordinators.get(core)?.recordMutation(id, toolName, result);
}
/** Attach accumulating editor batches to native Codemode's public parent/child lifecycle. */
export function registerNativeTextEditBatching(pi: ExtensionAPI, core: TextEditorCore): void {
  coordinators.set(core, new NativeTextEditBatchCoordinator(core, pi));
}

/** Accept one nested text mutation, or leave a non-batched call on its normal execution path. */
export function executeNativeTextEditBatch(
  core: TextEditorCore,
  id: string,
  registration: AnyTextMutationToolRegistration,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<AgentToolResult<FileMutationBatchResult>> | undefined {
  return coordinators.get(core)?.execute(id, registration, input, signal, context);
}
