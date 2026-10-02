import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Serializable source coordinates. Lines are one-based; columns are UTF-16 offsets. */
export interface ResultRange {
  readonly start: { readonly lineNumber: number; readonly column: number };
  readonly end: { readonly lineNumber: number; readonly column: number };
  readonly linewise?: boolean;
}

/** Backend-owned text targets; never accepted directly from untrusted JSON. */
export interface ResultSourceTarget {
  readonly source: string;
  readonly expectedContent: string;
  readonly ranges: readonly ResultRange[];
}

/** A resolved input keeps completeness separate from the size of its public preview. */
export interface ResolvedResultTargets {
  readonly targets: readonly ResultSourceTarget[];
  readonly complete: boolean;
}

/** Tool inputs allow returned result objects and JS-selected arrays. The store validates authority. */
export const resultInputSchema = Type.Union([
  Type.String(),
  Type.Object({}, { additionalProperties: true }),
  Type.Array(Type.Unknown()),
]);

const prefix = "RESULT#";
const event = "pi-agent-resource:result-targets";

type ResultEntry = { readonly cwd: string } & (
  | (ResolvedResultTargets & { readonly state: "ready" })
  | { readonly state: "pending" }
  | { readonly state: "rejected"; readonly reason: string }
);

/** Stores immutable source selections for one extension runtime, isolated by worktree. */
export class ResultTargetStore {
  readonly #entries = new Map<string, ResultEntry>();

  /** Forget results when the session closes or the extensions reload. */
  public clear(): void {
    this.#entries.clear();
  }

  /** Register trusted resolver data, not a live Resource or agent-supplied coordinates. */
  public register(targets: readonly ResultSourceTarget[], cwd: string, complete = true): string {
    const reference = `${prefix}${randomUUID()}`;
    this.#entries.set(reference, {
      state: "ready",
      targets: combineTargets(targets),
      complete,
      cwd: path.resolve(cwd),
    });
    return reference;
  }

  /** Reserve an operation result before writing. It has no source authority until confirmed. */
  public reserve(cwd: string): string {
    const reference = `${prefix}${randomUUID()}`;
    this.#entries.set(reference, { state: "pending", cwd: path.resolve(cwd) });
    return reference;
  }

  /** Resolve one pending operation to an immutable committed snapshot, exactly once. */
  public confirm(reference: string, targets: readonly ResultSourceTarget[], cwd: string): void {
    const entry = this.#entries.get(reference);
    if (entry?.state !== "pending" || entry.cwd !== path.resolve(cwd))
      throw new Error("Only a pending result in this worktree can be confirmed.");
    this.#entries.set(reference, {
      state: "ready",
      cwd: entry.cwd,
      targets: combineTargets(targets),
      complete: true,
    });
  }

  /** Failed or cancelled operations cannot turn their reserved handle into live text. */
  public reject(reference: string, reason: string): void {
    const entry = this.#entries.get(reference);
    if (entry?.state !== "pending") return;
    this.#entries.set(reference, { state: "rejected", cwd: entry.cwd, reason });
  }

  /** Traverse supported result shapes and resolve only registered source targets. */
  public resolve(input: unknown, cwd: string): ResolvedResultTargets {
    const references = this.#references(input);
    const targets: ResultSourceTarget[] = [];
    let complete = true;
    for (const reference of references) {
      const entry = this.#entries.get(reference);
      if (entry === undefined)
        throw new Error("Result target expired or unknown; repeat Read/Search.");
      if (entry.cwd !== path.resolve(cwd))
        throw new Error("Result target belongs to another worktree.");
      if (entry.state === "pending")
        throw new Error("Result target is pending; its write has not been confirmed.");
      if (entry.state === "rejected") throw new Error(entry.reason);
      complete &&= entry.complete;
      targets.push(...entry.targets);
    }
    return { targets: combineTargets(targets), complete };
  }

  /** Reject changed source bytes before a consumer uses a retained selection. */
  public async verify(result: ResolvedResultTargets, signal?: AbortSignal): Promise<void> {
    await verifyResultTargets(result, signal);
  }

  #references(input: unknown): string[] {
    if (typeof input === "string" && input.startsWith(prefix)) return [input];
    if (Array.isArray(input)) return input.flatMap((child) => this.#references(child));
    if (input === null || typeof input !== "object") throw new Error("Unsupported result input.");
    const value = input as Record<string, unknown>;
    if ("status" in value) {
      if (value.status !== "success")
        throw new Error("Only successful source results can be consumed.");
      return this.#references(value.data);
    }
    if (typeof value.target === "string" && value.target.startsWith(prefix)) return [value.target];
    if (value.kind === "resources" && Array.isArray(value.resources))
      return this.#references(value.resources);
    throw new Error(
      "This result has no supported source target; do not use preview text as a source.",
    );
  }
}

/** Verify retained source snapshots for tools and provider refresh operations. */
export async function verifyResultTargets(
  result: ResolvedResultTargets,
  signal?: AbortSignal,
): Promise<void> {
  const contents = new Map<string, string>();
  for (const target of result.targets) {
    signal?.throwIfAborted();
    let current = contents.get(target.source);
    if (current === undefined) {
      current = await readFile(target.source, { encoding: "utf8", signal });
      contents.set(target.source, current);
    }
    if (current !== target.expectedContent)
      throw new Error("Result target is stale; repeat Read/Search.");
  }
}
function combineTargets(targets: readonly ResultSourceTarget[]): ResultSourceTarget[] {
  const grouped = new Map<
    string,
    { source: string; expectedContent: string; ranges: ResultRange[]; seen: Set<string> }
  >();
  for (const target of targets) {
    const previous = grouped.get(target.source);
    if (previous !== undefined && previous.expectedContent !== target.expectedContent)
      throw new Error("Result targets refer to different snapshots of the same source.");
    const combined = previous ?? {
      source: target.source,
      expectedContent: target.expectedContent,
      ranges: [],
      seen: new Set<string>(),
    };
    for (const range of target.ranges) {
      const key = JSON.stringify(range);
      if (combined.seen.has(key)) continue;
      combined.seen.add(key);
      combined.ranges.push(structuredClone(range));
    }
    grouped.set(target.source, combined);
  }
  return [...grouped.values()]
    .filter((target) => target.ranges.length > 0)
    .map(({ seen: _seen, ...target }) => ({
      ...target,
      ranges: target.ranges.sort(
        (left, right) =>
          left.start.lineNumber - right.start.lineNumber ||
          left.start.column - right.start.column ||
          left.end.lineNumber - right.end.lineNumber ||
          left.end.column - right.end.column,
      ),
    }));
}
/** Share one backend store through Pi's extension event bus, without process-global state. */
export function connectResultTargets(pi: ExtensionAPI): ResultTargetStore {
  let existing: ResultTargetStore | undefined;
  pi.events.emit(event, {
    accept: (store: ResultTargetStore) => {
      existing = store;
    },
  });
  if (existing !== undefined) return existing;
  const store = new ResultTargetStore();
  const unsubscribe = pi.events.on(event, (request) => {
    if (
      request !== null &&
      typeof request === "object" &&
      "accept" in request &&
      typeof request.accept === "function"
    )
      (request.accept as (store: ResultTargetStore) => void)(store);
  });
  pi.on("session_start", () => {
    store.clear();
  });
  pi.on("session_shutdown", () => {
    store.clear();
    unsubscribe();
  });
  return store;
}
