import type { FileMutationResult } from "#src/api/mutation-result.js";
import { isDeepStrictEqual } from "node:util";
import { requiredValue } from "pi-agent-invariant";
import type { ReadToolResult } from "pi-agent-read/api/tools/read";

/** Host-owned outcome; identity refers to one call, not equal result contents. */
interface OperationResult {
  readonly presentation?: ReadToolResult;
  readonly id: string;
  readonly kind: "read" | "mutation";
  readonly value: unknown;
}

type ExplicitResult =
  | {
      readonly kind: "operation";
      readonly id: string;
      readonly value: unknown;
      readonly presentation?: ReadToolResult;
    }
  | { readonly kind: "value"; readonly value: unknown };

/** Final observed contents for one canonical resource; null means absent. */
interface FileState {
  readonly source: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** Collected data for the formatter; operation receipts are not intermediate file views. */
interface SelectedResults {
  readonly explicit: readonly ExplicitResult[];
  readonly automatic: readonly OperationResult[];
  readonly files: readonly FileState[];
}

/** Per-invocation output selection and file-state consolidation, independent of guest return. */
export class ApplyResults {
  readonly #operations = new Map<string, OperationResult>();
  readonly #explicit: ExplicitResult[] = [];
  readonly #explicitOperations = new Set<string>();
  readonly #files = new Map<string, FileState>();
  #hasMutation = false;
  readonly #mutationPresentations = new Map<string, FileMutationResult>();

  /** Retain configured post-edit annotations on the host, outside guest serialization. */
  rememberMutation(source: string, presentation: FileMutationResult): void {
    this.#mutationPresentations.set(source, presentation);
  }

  /** Latest observed presentation for a canonical file. */
  mutationPresentation(source: string): FileMutationResult | undefined {
    return this.#mutationPresentations.get(source);
  }

  /** Mutation receipts in execution order, including explicitly selected operations. */
  mutationValues(): readonly unknown[] {
    return [...this.#operations.values()]
      .filter(({ kind }) => kind === "mutation")
      .map(({ value }) => value);
  }

  /** Records even refused mutations so they take precedence over automatic reads. */
  record(
    id: string,
    kind: OperationResult["kind"],
    value: unknown,
    presentation?: ReadToolResult,
  ): void {
    if (this.#operations.has(id)) throw new Error(`Duplicate operation identity: ${id}`);
    this.#operations.set(id, {
      id,
      kind,
      value,
      ...(presentation === undefined ? {} : { presentation }),
    });
    this.#hasMutation ||= kind === "mutation";
  }

  /** Adds a known operation once, preserving explicit selection order. */
  addOperation(id: string): void {
    const operation = requiredValue(this.#operations.get(id));
    if (this.#explicitOperations.has(id)) return;
    this.#explicitOperations.add(id);
    this.#explicit.push({
      kind: "operation",
      id,
      value: operation.value,
      ...(operation.presentation === undefined ? {} : { presentation: operation.presentation }),
    });
  }

  /** Checks guest provenance against host data; edited values remain explicit additions. */
  add(value: unknown, operationId?: string): void {
    const operation = operationId === undefined ? undefined : this.#operations.get(operationId);
    if (operation !== undefined && isDeepStrictEqual(operation.value, value)) {
      this.addOperation(operation.id);
    } else {
      this.addValue(value);
    }
  }
  /** Adds arbitrary script output; equal values are not assumed to be duplicate calls. */
  addValue(value: unknown): void {
    this.#explicit.push({ kind: "value", value });
  }

  /** Records final observed text after an operation, retaining the first pre-edit state. */
  updateFile(source: string, before: string | null, after: string | null): void {
    const previous = this.#files.get(source);
    this.#files.set(source, {
      source,
      before: previous === undefined ? before : previous.before,
      after,
    });
  }

  /** A whole-file operation supersedes any previously recorded text snapshot. */
  forgetFile(source: string): void {
    this.#files.delete(source);
    this.#mutationPresentations.delete(source);
  }
  /** Selects output without deleting the underlying operation receipts. */
  select(): SelectedResults {
    return {
      explicit: [...this.#explicit],
      automatic: [...this.#operations.values()].filter(
        ({ id, kind }) =>
          !this.#explicitOperations.has(id) && (!this.#hasMutation || kind === "mutation"),
      ),
      files: [...this.#files.values()],
    };
  }
}
