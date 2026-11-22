import { resultValueId, type ResultTargetStore } from "pi-agent-resource";

/** Backend-issued name selections retain semantic identity independently of public coordinates. */
export interface NameCapture {
  readonly source: string;
  readonly selector: readonly string[];
}
export class NameCaptures {
  readonly #captures = new Map<string, NameCapture>();
  register(ids: readonly (string | undefined)[], capture: NameCapture): void {
    for (const id of ids)
      if (id !== undefined) {
        this.#captures.set(id, capture);
        if (id.startsWith("RESULT#")) this.#captures.set(id.slice(7), capture);
      }
  }
  get(value: unknown): NameCapture | undefined {
    const id = resultValueId(value) ?? value;
    return typeof id === "string" ? this.#captures.get(id) : undefined;
  }
  find(input: unknown): { capture: NameCapture; reference: unknown } | undefined {
    if (typeof input !== "object" || input === null) return undefined;
    const find = (value: unknown): ReturnType<NameCaptures["find"]> => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const selected = find(item);
          if (selected !== undefined) return selected;
        }
        return undefined;
      }
      const capture = this.get(value);
      return capture === undefined ? undefined : { capture, reference: value };
    };
    const fields = input as Record<string, unknown>;
    for (const field of ["path", "at", "from", "after", "through", "before"]) {
      const selected = find(fields[field]);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  matches(input: unknown): boolean {
    return this.find(input) !== undefined;
  }
}

/** The current guarded selection, never agent-supplied range fields. */
export async function currentNameCapture(
  store: ResultTargetStore,
  value: unknown,
  cwd: string,
  signal?: AbortSignal,
) {
  const selected = await store.resolveCurrent(value, cwd, signal);
  const target = selected.targets[0];
  const range = target?.ranges[0];
  if (
    !selected.complete ||
    selected.targets.length !== 1 ||
    target?.ranges.length !== 1 ||
    range === undefined ||
    range.adjusted
  )
    throw new Error("The name capture changed. Repeat lsp_search before renaming.");
  await store.verify(selected, signal);
  return { target, range };
}
