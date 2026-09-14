const timeoutMarker = Symbol("search-timeout");

/** Error returned when a search exceeds its configured time limit. */
export class SearchTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SearchTimeoutError";
  }
}

/** Run one search with optional timeout and parent-signal cancellation. */
export async function runWithSearchTimeout<T>(
  timeoutMs: number | null,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === null) {
    return operation(parentSignal);
  }

  const timeoutController = new AbortController();
  const operationSignal =
    parentSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([parentSignal, timeoutController.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timeoutMarker>((resolve) => {
    timer = setTimeout(() => {
      resolve(timeoutMarker);
      timeoutController.abort();
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation(operationSignal), timeout]);
    if (result === timeoutMarker) {
      throw new SearchTimeoutError(
        `Search timed out after ${formatDuration(timeoutMs)}. Try a smaller path scope.`,
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function formatDuration(timeoutMs: number): string {
  if (timeoutMs % 1000 !== 0) {
    return `${String(timeoutMs)}ms`;
  }

  const seconds = timeoutMs / 1000;
  return `${String(seconds)} ${seconds === 1 ? "second" : "seconds"}`;
}
