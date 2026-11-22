import { EDIT_WAIT_TIMEOUT_MS, ResourceScheduler } from "pi-agent-resource";

export class IndexMutationQueue {
  private readonly scheduler = new ResourceScheduler();

  run<Result>(
    file: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.scheduler.run(undefined, operation, signal, {
      waitTimeoutMs: EDIT_WAIT_TIMEOUT_MS,
      waitFor: `the Git index for ${file}`,
    });
  }
}
