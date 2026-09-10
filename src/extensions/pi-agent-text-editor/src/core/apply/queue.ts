/** Serializes one Apply invocation, including calls submitted through Promise.all. */
export class ApplyQueue {
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  /** Runs after earlier operations settle; a refusal does not poison later calls. */
  submit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Apply execution has ended"));
    const pending = this.#tail.then(() => {
      if (this.#closed) throw new Error("Apply execution has ended");
      return operation();
    });
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /** Stops queued calls and waits for active host work before reporting final effects. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }
}
