/** Cancel one wait without cancelling work shared by other callers. */
export async function waitWithSignal<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    // The request already exists; disposing its connection can still reject it later.
    void request.catch(() => undefined);
    throw signal.reason;
  }
  if (!signal) return request;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** One owned startup shared by callers. The last cancelled wait awaits physical cleanup. */
export class SharedStartup<T> {
  readonly controller = new AbortController();
  readonly promise: Promise<T>;
  settled = false;
  private waiters = 0;

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal);
    const settled = () => {
      this.settled = true;
    };
    void this.promise.then(settled, settled);
  }

  async wait(signal?: AbortSignal): Promise<T> {
    this.waiters += 1;
    const outcome = await waitWithSignal(this.promise, signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    this.waiters -= 1;
    if (!this.settled && this.waiters === 0) {
      this.controller.abort(signal?.reason);
      try {
        await this.promise;
      } catch (error) {
        if (error !== this.controller.signal.reason) {
          throw new AggregateError(
            [this.controller.signal.reason, error],
            "Startup cancellation and cleanup failed",
            { cause: error },
          );
        }
      }
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
}
