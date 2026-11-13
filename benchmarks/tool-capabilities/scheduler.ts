export async function schedule<T, R>(
  items: T[],
  concurrency: number,
  controller: AbortController,
  options: {
    run: (item: T, signal: AbortSignal) => Promise<R>;
    resource: (item: T) => string | undefined;
    stopReason: (result: R) => string | undefined;
    publish: (results: R[], stop?: { reason: string; result: R }) => Promise<void>;
  },
): Promise<{ stoppedFor?: string }> {
  const pending = items.map((item, index) => ({ item, index, resource: options.resource(item) }));
  const active = new Map<number, { resource?: string; promise: Promise<void> }>();
  const finished: ({ index: number; result: R } | { index: number; error: unknown })[] = [];
  const completed = new Map<number, R>();
  let stop: { reason: string; result: R } | undefined;
  let failure: unknown;
  let failed = false;
  let publishFailed = false;
  while (pending.length || active.size) {
    while (finished.length) {
      const settled = finished.shift()!;
      active.delete(settled.index);
      if ("error" in settled) {
        if (!failed) failure = settled.error;
        failed = true;
        controller.abort();
        continue;
      }
      completed.set(settled.index, settled.result);
      if (!publishFailed) {
        try {
          await options.publish(
            [...completed.entries()].sort(([a], [b]) => a - b).map(([, result]) => result),
            stop,
          );
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
          publishFailed = true;
          controller.abort();
        }
      }
    }
    while (!controller.signal.aborted && active.size < concurrency) {
      const next = pending.findIndex(
        (candidate) =>
          !candidate.resource ||
          ![...active.values()].some((entry) => entry.resource === candidate.resource),
      );
      if (next < 0) break;
      const entry = pending.splice(next, 1)[0]!;
      const promise = Promise.resolve()
        .then(() => options.run(entry.item, controller.signal))
        .then(
          (result) => {
            try {
              const reason = options.stopReason(result);
              if (reason && !stop) {
                stop = { reason, result };
                controller.abort();
              }
              finished.push({ index: entry.index, result });
            } catch (error) {
              controller.abort();
              finished.push({ index: entry.index, error });
            }
          },
          (error: unknown) => {
            controller.abort();
            finished.push({ index: entry.index, error });
          },
        );
      active.set(entry.index, { resource: entry.resource, promise });
    }
    if (!active.size) break;
    if (!finished.length) await Promise.race([...active.values()].map((entry) => entry.promise));
  }
  if (failed) throw failure;
  return { stoppedFor: stop?.reason };
}
