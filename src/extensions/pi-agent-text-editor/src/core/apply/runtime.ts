import type { RunLimits } from "run";
import { fileOperations } from "#src/core/file-operations.js";
import { ApplyQueue } from "#src/core/apply/queue.js";

/** Only IDE operations approved for the guest; remove maps to the standalone delete tool. */
export const applyOperations = [
  "read",
  "search",
  "diff",
  "write",
  "replace",
  "insert",
  "remove",
  "copy",
  "move",
  "undo",
  "stage",
  "unstage",
  ...fileOperations,
] as const;
export type ApplyOperation = (typeof applyOperations)[number];

/** The host records outcomes before returning them across the guest bridge. */
export interface ApplyRuntimeHost {
  execute(
    operation: ApplyOperation,
    arguments_: unknown,
    signal: AbortSignal,
    id: string,
  ): Promise<unknown>;
  result(value: unknown, operationId?: string): Promise<void>;
}

/** Runs a fresh composition and drains host work on success, failure, or cancellation. */
export async function executeApplySource(
  source: string,
  host: ApplyRuntimeHost,
  signal?: AbortSignal,
  limits?: RunLimits,
): Promise<void> {
  const { createRunner, getHostFunctionContext } = await import("run");
  const queue = new ApplyQueue();
  const operations = Object.fromEntries(
    applyOperations.map((operation) => [
      operation,
      (arguments_: unknown) => {
        const context = getHostFunctionContext();
        return queue.submit(async () => {
          context.abortSignal.throwIfAborted();
          try {
            return {
              ok: true,
              value: await host.execute(
                operation,
                arguments_,
                context.abortSignal,
                context.requestId,
              ),
              id: context.requestId,
            };
          } catch (error) {
            return { ok: false, error: serializeApplyError(error) };
          }
        });
      },
    ]),
  );
  try {
    const runner = createRunner({
      syncHostFunctions: {
        __apply: {
          ...operations,
          result: (value: unknown, operationId?: string) =>
            queue.submit(() => host.result(value, operationId)),
        },
      },
    });
    await runner.run({ source: `${guestBindings()}\n${source}`, abortSignal: signal, limits });
  } finally {
    await queue.close();
  }
}

/** Preserves operation error fields without sending host Error instances across the bridge. */
export function serializeApplyError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (!(error instanceof Error)) return { code: "OPERATION_FAILED", message: String(error) };
  return {
    code: "code" in error && typeof error.code === "string" ? error.code : "OPERATION_FAILED",
    message: error.message,
    ...("details" in error ? { details: error.details } : {}),
  };
}

function guestBindings(): string {
  return `const { ${applyOperations.join(", ")}, result } = (() => {
    const origins = new WeakMap();
    const invoke = (name, args) => {
      const response = __apply[name](args);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.value !== null && typeof response.value === "object") origins.set(response.value, response.id);
      return response.value;
    };
    return {
      ${applyOperations.map((name) => `${name}: (args) => invoke(${JSON.stringify(name)}, args)`).join(",\n")},
      result: (value) => __apply.result(value, value !== null && typeof value === "object" ? origins.get(value) : undefined),
    };
  })();`;
}
