export class IndexMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => void 0,
      () => void 0,
    );
    return result;
  }
}
