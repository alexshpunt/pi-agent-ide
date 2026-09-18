/** Buffer ready notifications at a fixed first-arrival deadline and serialize flushes. */
export function createDiagnosticDelivery(
  flush: (cwd: string) => Promise<void>,
  delayMs: number,
  onError: (error: unknown) => void = console.error,
): { schedule(cwd: string): void; dispose(): void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  let pending = Promise.resolve();
  return {
    schedule(cwd) {
      if (closed || timers.has(cwd)) return;
      const timer = setTimeout(() => {
        timers.delete(cwd);
        pending = pending
          .then(async () => {
            if (!closed) await flush(cwd);
          })
          .catch(onError);
      }, delayMs);
      timers.set(cwd, timer);
    },
    dispose() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
