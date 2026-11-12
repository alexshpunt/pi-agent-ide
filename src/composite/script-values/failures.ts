/** One IDE call that failed inside a Codemode script. */
export interface IdeCallFailure {
  readonly tool: string;
  /** The source the call named, as its call title shows it. */
  readonly source?: string;
  /** The readable error text a direct call shows, including its recovery steps and anchors. */
  readonly reason: string;
  /** Files the call changed before it failed. */
  readonly changed?: readonly string[];
  /** Files the call may have changed. */
  readonly unknown?: readonly string[];
}

/** An IDE call a script made: its tool and the source it named. */
export interface IdeCall {
  readonly id: string;
  readonly tool: string;
  readonly source?: string;
}

/** One operation of a committed editor batch, from the batch receipt of the Codemode result. */
export interface BatchOperation extends Pick<IdeCallFailure, "changed" | "unknown"> {
  readonly id: string;
  readonly effect: string;
  readonly errors: readonly { readonly message: string }[];
}

/** Counts the IDE calls of each Codemode script and keeps the ones that failed. */
export class CodemodeCallLedger {
  readonly #scripts = new Map<
    string,
    { calls: Map<string, IdeCall>; failures: Map<string, IdeCallFailure> }
  >();

  record(script: string, call: IdeCall, failure?: Omit<IdeCallFailure, "tool" | "source">): void {
    const entry = this.#scripts.get(script) ?? { calls: new Map(), failures: new Map() };
    entry.calls.set(call.id, call);
    if (failure !== undefined) entry.failures.set(call.id, { ...identity(call), ...failure });
    this.#scripts.set(script, entry);
  }

  /**
   * Add the edits that a script got a value for when they were accepted, and that failed or had an
   * unknown effect when their batch was committed.
   */
  recordBatch(script: string, operations: readonly BatchOperation[]): void {
    const entry = this.#scripts.get(script);
    if (entry === undefined) return;
    for (const operation of operations) {
      const call = entry.calls.get(operation.id);
      if (call === undefined || entry.failures.has(operation.id)) continue;
      if (operation.errors.length === 0 && operation.effect !== "unknown") continue;
      entry.failures.set(operation.id, {
        ...identity(call),
        reason: [
          "The edit was accepted, then its editor batch failed when it was saved.",
          ...operation.errors.map((error) => error.message),
        ].join("\n"),
        ...(operation.changed === undefined ? {} : { changed: operation.changed }),
        ...(operation.unknown === undefined ? {} : { unknown: operation.unknown }),
      });
    }
  }

  /** Remove the script's record. Returns its failure block, or `undefined` when no call failed. */
  take(script: string): string | undefined {
    const entry = this.#scripts.get(script);
    this.#scripts.delete(script);
    return entry === undefined || entry.failures.size === 0
      ? undefined
      : formatFailures(
          entry.calls.size,
          // In the order the calls returned, including edits whose batch failed after later calls.
          [...entry.calls.keys()].flatMap((id) => entry.failures.get(id) ?? []),
        );
  }

  clear(): void {
    this.#scripts.clear();
  }
}

function identity(call: IdeCall): Pick<IdeCallFailure, "tool" | "source"> {
  return { tool: call.tool, ...(call.source === undefined ? {} : { source: call.source }) };
}

/** The block that ends a Codemode result: every failed IDE call with what a direct call shows. */
export function formatFailures(calls: number, failures: readonly IdeCallFailure[]): string {
  const lines = [`${failures.length} of ${calls} IDE call${calls === 1 ? "" : "s"} failed:`];
  for (const failure of failures) {
    lines.push(`- ${failure.tool}${failure.source === undefined ? "" : ` ${failure.source}`}`);
    const effects = [
      ...(failure.changed?.length ? [`Changed: ${failure.changed.join(", ")}.`] : []),
      ...(failure.unknown?.length ? [`Effect unknown: ${failure.unknown.join(", ")}.`] : []),
    ];
    if (effects.length > 0)
      lines.push(`  ${effects.join(" ")} Do not repeat this edit blindly; Read the files first.`);
    for (const line of failure.reason.split("\n")) lines.push(line === "" ? "" : `  ${line}`);
  }
  return lines.join("\n");
}

/**
 * Files an edit changed or may have changed, from its validated `{ data: { files } }` receipt.
 * `display` shows a source as the block names it, for example relative to the workspace.
 */
export function fileEffects(
  outcome: unknown,
  display: (source: string) => string = (source) => source,
): Pick<IdeCallFailure, "changed" | "unknown"> {
  const data = record(outcome) ? outcome.data : undefined;
  const files: unknown[] = record(data) && Array.isArray(data.files) ? data.files : [];
  const sources = (effect: string) =>
    files.flatMap((file) =>
      record(file) && file.effect === effect && typeof file.source === "string"
        ? [display(file.source)]
        : [],
    );
  const changed = sources("applied");
  const unknown = sources("unknown");
  return {
    ...(changed.length > 0 && { changed }),
    ...(unknown.length > 0 && { unknown }),
  };
}

/** The operations of the editor batch receipts that the native batch puts on a Codemode result. */
export function batchOperations(
  details: unknown,
  display: (source: string) => string = (source) => source,
): BatchOperation[] {
  const reports = record(details) ? details.editorBatchResults : undefined;
  if (!Array.isArray(reports)) return [];
  return reports.flatMap((report: unknown) => {
    const operations: unknown[] =
      record(report) && record(report.data) && Array.isArray(report.data.operations)
        ? (report.data.operations as unknown[])
        : [];
    return operations.flatMap((operation) =>
      record(operation) &&
      typeof operation.id === "string" &&
      typeof operation.effect === "string" &&
      Array.isArray(operation.errors)
        ? [
            {
              id: operation.id,
              effect: operation.effect,
              errors: (operation.errors as unknown[]).flatMap((error) =>
                record(error) && typeof error.message === "string"
                  ? [{ message: error.message }]
                  : [],
              ),
              ...fileEffects({ data: { files: operation.files } }, display),
            },
          ]
        : [],
    );
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
