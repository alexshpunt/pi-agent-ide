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
  matches(input: unknown): boolean {
    if (typeof input !== "object" || input === null) return false;
    const contains = (value: unknown): boolean =>
      Array.isArray(value) ? value.some(contains) : this.get(value) !== undefined;
    const fields = input as Record<string, unknown>;
    return [fields.path, fields.start, fields.end].some(contains);
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
