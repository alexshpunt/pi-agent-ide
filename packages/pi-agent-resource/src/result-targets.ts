import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Public source inputs are paths, unchanged text results, issued IDs or arrays of those strings. */
export const resultInputSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

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
  readonly #matchReferences = new Map<string, string>();
  readonly #snapshots = new Map<
    string,
    { source: string; cwd: string; stamp: string | undefined }
  >();
  readonly #results = new Map<
    string,
    { cwd: string; digest: string; consumable: boolean; references: string[]; resources: string[] }
  >();

  /** Forget results when the session closes or the extensions reload. */
  public clear(): void {
    this.#entries.clear();
    this.#matchReferences.clear();
    this.#snapshots.clear();
    this.#results.clear();
  }

  /** Register trusted resolver data, not a live Resource or agent-supplied coordinates. */
  public register(targets: readonly ResultSourceTarget[], cwd: string, complete = true): string {
    for (const target of targets) this.refresh(target.source, cwd);
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
    for (const target of targets) this.refresh(target.source, cwd);
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
    input = this.source(input, cwd);
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
      for (const target of entry.targets) this.refresh(target.source, cwd);
      if (!this.#entries.has(reference))
        throw new Error("Result target expired after its snapshot changed; repeat Read/Search.");
      complete &&= entry.complete;
      targets.push(...entry.targets);
    }
    return { targets: combineTargets(targets), complete };
  }

  /** Resolve individual ranges in declared handle order for one-to-one source/destination pairs. */
  public resolveOrdered(input: unknown, cwd: string): ResolvedResultTargets {
    const resolved = this.resolve(input, cwd);
    const targets: ResultSourceTarget[] = [];
    const seen = new Set<string>();
    for (const reference of new Set(this.#references(this.source(input, cwd)))) {
      for (const target of this.resolve(reference, cwd).targets) {
        for (const range of target.ranges) {
          const identity = JSON.stringify([target.source, range]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          targets.push({ ...target, ranges: [range] });
        }
      }
    }
    return { targets, complete: resolved.complete };
  }

  /** Reject changed source bytes before a consumer uses a retained selection. */
  public async verify(result: ResolvedResultTargets, signal?: AbortSignal): Promise<void> {
    try {
      await verifyResultTargets(result, signal);
    } catch (error) {
      if (!signal?.aborted) for (const target of result.targets) this.invalidate(target.source);
      throw error;
    }
  }

  /** Register readable output without exposing the stored tool data to the agent. */
  public publish(outcome: unknown, text: string, cwd: string, resources: string[] = []): string {
    const id = randomUUID();
    for (const source of resources) this.refresh(source, cwd);
    let references: string[] = [];
    try {
      references = this.#references(outcome);
    } catch {
      /* Not every result grants a text selection. */
    }
    const shown = `<system-result note="Internal reference; not part of the file. Do not edit."><uuid>${id}</uuid></system-result>\n${text}`;
    const consumable =
      outcome !== null &&
      typeof outcome === "object" &&
      "status" in outcome &&
      outcome.status === "success";
    if (consumable && "data" in outcome) {
      const data = outcome.data;
      if (
        data !== null &&
        typeof data === "object" &&
        "matches" in data &&
        Array.isArray(data.matches)
      ) {
        const matches: unknown[] = data.matches;
        for (const match of matches) {
          if (
            match === null ||
            typeof match !== "object" ||
            !("target" in match) ||
            typeof match.target !== "string" ||
            !this.#entries.has(match.target) ||
            !("references" in match)
          )
            continue;
          const references = match.references;
          if (
            references !== null &&
            typeof references === "object" &&
            "match" in references &&
            typeof references.match === "string" &&
            /^SEARCH#[A-F\d]+:\d+:match$/u.test(references.match)
          )
            this.#matchReferences.set(references.match, match.target);
        }
      }
    }
    this.#results.set(id, {
      cwd: path.resolve(cwd),
      digest: createHash("sha256").update(shown).digest("hex"),
      consumable,
      references,
      resources,
    });
    return shown;
  }

  /** Resolve only issued result strings or IDs. Preview text never defines source authority. */
  public source(input: unknown, cwd: string, allowResource: boolean | "live" = false): unknown {
    if (Array.isArray(input)) return input.map((item) => this.source(item, cwd, allowResource));
    if (typeof input !== "string") return input;
    const matchTarget = this.#matchReferences.get(input);
    if (matchTarget) return this.source(matchTarget, cwd, allowResource);
    const envelope =
      /^<system-result\b[^>]*><uuid>([a-f\d-]{36})<\/uuid><\/system-result>(?:\n|$)/u.exec(input);
    const id = envelope?.[1] ?? (input.startsWith(prefix) ? input.slice(prefix.length) : input);
    const isId = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u.test(id);
    if (!envelope && !isId) {
      if (input.startsWith("<system-result")) throw new Error("Invalid system result reference.");
      return input;
    }
    const result = this.#results.get(id);
    // Existing backend selection handles share RESULT# syntax, but never accept an unknown UUID.
    if (!result && !envelope && input.startsWith(prefix) && this.#entries.has(input)) return input;
    if (!result)
      throw new Error(
        "Result reference expired or unknown. Run Read/Search again and use the new result.",
      );
    if (result.cwd !== path.resolve(cwd)) throw new Error("Result belongs to another worktree.");
    if (envelope && createHash("sha256").update(input).digest("hex") !== result.digest)
      throw new Error("Result text changed; pass the original result or its UUID.");
    for (const resource of result.resources) this.refresh(resource, cwd);
    if (!this.#results.has(id))
      throw new Error("Result reference expired. Run Read/Search again and use the new result.");
    if (!result.consumable) throw new Error("Only successful source results can be consumed.");
    for (const reference of result.references) {
      if (!this.#entries.has(reference)) {
        this.#results.delete(id);
        throw new Error("Result reference expired. Run Read/Search again and use the new result.");
      }
    }
    if (result.references.length === 1) return result.references[0];
    if (result.references.length > 1) return result.references;
    const resource = result.resources.length === 1 ? result.resources[0] : undefined;
    if (
      resource &&
      (allowResource === true || (allowResource === "live" && /^(?:shell|debug):/u.test(resource)))
    )
      return resource;
    throw new Error("This result has no reusable text selection.");
  }

  /** Permanently retire every ready selection of a changed file, including derived results. */
  public invalidate(source: string): void {
    const removed = new Set<string>();
    for (const [reference, entry] of this.#entries) {
      if (
        entry.state === "ready" &&
        entry.targets.some((target) => sourcePath(target.source, entry.cwd) === source)
      ) {
        this.#entries.delete(reference);
        removed.add(reference);
      }
    }
    for (const [id, result] of this.#results)
      if (
        result.resources.some((resource) => sourcePath(resource, result.cwd) === source) ||
        result.references.some((reference) => removed.has(reference))
      )
        this.#results.delete(id);
  }

  /** Detect filesystem generations, so restoring old bytes never revives an old reference. */
  public refresh(source: string, cwd: string): void {
    const identity = sourcePath(source, cwd);
    const key = JSON.stringify([path.resolve(cwd), identity]);
    const stamp = fileStamp(source, cwd);
    const previous = this.#snapshots.get(key);
    if (previous && previous.stamp !== stamp) this.invalidate(identity);
    this.#snapshots.set(key, { source, cwd, stamp });
  }

  /** Check surviving snapshots at a script boundary, including final formatting. */
  public refreshAll(): void {
    for (const snapshot of [...this.#snapshots.values()])
      this.refresh(snapshot.source, snapshot.cwd);
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

function sourcePath(source: string, cwd: string): string {
  const file = source.startsWith("raw:") ? source.slice(4) : source;
  if (file.startsWith("file:")) {
    try {
      return fileURLToPath(file);
    } catch {
      /* Unresolved protocol labels have no filesystem stamp. */
    }
  }
  return path.resolve(cwd, file);
}
function fileStamp(source: string, cwd: string): string | undefined {
  try {
    const stat = statSync(sourcePath(source, cwd), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return undefined;
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
