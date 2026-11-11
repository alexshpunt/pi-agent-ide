import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLineMap, describeLostRange, moveRange, type LineMap } from "./line-map.ts";

/** Serializable source coordinates. Lines are one-based; columns are UTF-16 offsets. */
export interface ResultRange {
  readonly start: { readonly lineNumber: number; readonly column: number };
  readonly end: { readonly lineNumber: number; readonly column: number };
  readonly linewise?: boolean;
  /**
   * The selected lines changed after the result was issued, and this range covers the same region
   * of the current text. Read-only consumers may search it; anything that edits needs the text
   * that was selected, so resolving it for an edit fails.
   */
  readonly adjusted?: boolean;
}

/** Backend-owned text targets; never accepted directly from untrusted JSON. */
export interface ResultSourceTarget {
  /** Trusted owning-provider reread; never accepted from agent-supplied coordinates. */
  readonly readCurrent?: (signal?: AbortSignal) => Promise<string>;
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
const liveResource = /^(?:shell|debug):/u;
/** Larger files are never reread on a change; their selections are retired instead. */
const maxRebasedBytes = 16 * 1024 * 1024;
/** What the store knows about one file of one worktree. */
interface FileSnapshot {
  readonly source: string;
  readonly cwd: string;
  /** Filesystem generation; `undefined` for a missing file or a source without one. */
  readonly stamp: string | undefined;
  /** The file's text at `stamp`, once read. Every selection of the file is kept on this text. */
  content?: string;
  /** Another string object with the same text as `content`, so repeated comparisons stay cheap. */
  alias?: string;
  /** The last older text a new selection came from, with its map onto `content`. */
  older?: { readonly text: string; readonly map: LineMap | undefined };
}
type ResultEntry = { readonly cwd: string } & (
  | (ResolvedResultTargets & { readonly state: "ready" })
  | { readonly state: "pending" }
  | { readonly state: "rejected"; readonly reason: string }
);

/** Stores immutable source selections for one extension runtime, isolated by worktree. */
export class ResultTargetStore {
  readonly #entries = new Map<string, ResultEntry>();
  readonly #matchReferences = new Map<string, string>();
  readonly #referenceNames = new Map<string, string>();
  readonly #snapshots = new Map<string, FileSnapshot>();
  readonly #results = new Map<
    string,
    { cwd: string; digest: string; consumable: boolean; references: string[]; resources: string[] }
  >();
  /** One retained copy of each current source text, shared by every entry that snapshots it. */
  readonly #contents = new Map<string, { identity: string; content: string }>();

  /** Forget results when the session closes or the extensions reload. */
  public clear(): void {
    this.#entries.clear();
    this.#matchReferences.clear();
    this.#referenceNames.clear();
    this.#snapshots.clear();
    this.#results.clear();
    this.#contents.clear();
  }

  /** Register trusted resolver data, not a live Resource or agent-supplied coordinates. */
  public register(targets: readonly ResultSourceTarget[], cwd: string, complete = true): string {
    for (const target of targets) this.refresh(target.source, cwd);
    const reference = `${prefix}${randomUUID()}`;
    const aligned = this.#align(targets, cwd);
    this.#entries.set(
      reference,
      aligned.lost.length > 0
        ? { state: "rejected", cwd: path.resolve(cwd), reason: retiredReason(aligned.lost) }
        : {
            state: "ready",
            targets: combineTargets(this.#shareContents(aligned.targets, cwd)),
            complete,
            cwd: path.resolve(cwd),
          },
    );
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
    const aligned = this.#align(targets, cwd);
    this.#entries.set(
      reference,
      aligned.lost.length > 0
        ? { state: "rejected", cwd: entry.cwd, reason: retiredReason(aligned.lost) }
        : {
            state: "ready",
            cwd: entry.cwd,
            targets: combineTargets(this.#shareContents(aligned.targets, cwd)),
            complete: true,
          },
    );
  }

  /** Failed or cancelled operations cannot turn their reserved handle into live text. */
  public reject(reference: string, reason: string): void {
    const entry = this.#entries.get(reference);
    if (entry?.state !== "pending") return;
    this.#entries.set(reference, { state: "rejected", cwd: entry.cwd, reason });
  }

  /** Traverse supported result shapes and resolve only registered source targets. */
  public resolve(
    input: unknown,
    cwd: string,
    options: { readonly allowAdjusted?: boolean } = {},
  ): ResolvedResultTargets {
    input = this.source(input, cwd);
    const references = this.#references(input);
    this.#refreshEntries(references, cwd);
    const targets: ResultSourceTarget[] = [];
    let complete = true;
    for (const reference of references) {
      const current = this.#current(reference, options.allowAdjusted === true);
      complete &&= current.complete;
      targets.push(...current.targets);
    }
    return { targets: combineTargets(targets), complete };
  }

  /** Resolve individual ranges in declared handle order for one-to-one source/destination pairs. */
  public resolveOrdered(input: unknown, cwd: string): ResolvedResultTargets {
    const resolved = this.resolve(input, cwd);
    const targets: ResultSourceTarget[] = [];
    const seen = new Set<string>();
    // The files were refreshed once above; collect without another refresh so a write landing
    // now cannot put the pairs on two texts.
    for (const reference of new Set(this.#references(this.source(input, cwd)))) {
      for (const target of this.#current(reference, false).targets) {
        for (const range of target.ranges) {
          const identity = JSON.stringify([target.source, range]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          targets.push({ ...target, ranges: [structuredClone(range)] });
        }
      }
    }
    return { targets, complete: resolved.complete };
  }

  /**
   * Resolve a result for a consumer that only reads, such as Search. The targets carry the current
   * text of each source and the regions of it that the result selected, wherever other writers
   * moved or rewrote them. Fails only when a region cannot be found any more.
   */
  public async resolveCurrent(
    input: unknown,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ResolvedResultTargets> {
    return currentResultTargets(this.resolve(input, cwd, { allowAdjusted: true }), signal);
  }

  /**
   * Reject changed source bytes before a consumer uses a retained selection. A local file that
   * changed keeps its selections: the next use moves them to its new text, like any other write.
   * Selections of a source without a filesystem stamp cannot follow it and are retired.
   */
  public async verify(result: ResolvedResultTargets, signal?: AbortSignal): Promise<void> {
    try {
      await verifyResultTargets(result, signal);
    } catch (error) {
      if (!signal?.aborted)
        for (const target of result.targets)
          if (fileStamp(target.source, path.parse(target.source).root || ".") === undefined)
            this.invalidate(target.source);
      throw error;
    }
  }

  /** Bind a numbered Search selector to its owner's registered snapshot; all-selectors keep refreshing. */
  public registerSearchReference(reference: string, target: string, cwd: string): void {
    if (!/^SEARCH#[A-F\d]{4,64}:[1-9]\d*:(line|match)$/u.test(reference))
      throw new Error("Only numbered Search references can alias a snapshot.");
    if (!this.#entries.has(target))
      throw new Error("A Search reference needs a registered result target.");
    this.resolve(target, cwd);
    this.#matchReferences.set(reference, target);
    this.#referenceNames.set(target, reference);
  }

  /** Whether `registerSearchReference` bound this numbered Search reference to a snapshot. */
  public hasSearchReference(reference: string): boolean {
    return this.#matchReferences.has(reference);
  }

  /** The Search reference a handle was issued for, so messages name what the agent passed. */
  public referenceName(handle: string): string {
    return this.#referenceNames.get(handle) ?? handle;
  }
  /**
   * Targets of a numbered Search reference bound by `registerSearchReference`, or `undefined` when
   * none is bound. A bound reference that cannot be used throws the reason, with current lines.
   */
  public resolveSearchReference(reference: string, cwd: string): ResolvedResultTargets | undefined {
    const target = this.#matchReferences.get(reference);
    return target === undefined ? undefined : this.resolve(target, cwd);
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
      (allowResource === true || (allowResource === "live" && liveResource.test(resource)))
    )
      return resource;
    throw new Error("This result has no reusable text selection.");
  }

  /** Permanently retire every ready selection of a changed file, including derived results. */
  public invalidate(source: string): void {
    for (const [key, shared] of this.#contents)
      if (shared.identity === source) this.#contents.delete(key);
    for (const [key, snapshot] of this.#snapshots)
      if (sourcePath(snapshot.source, snapshot.cwd) === source)
        this.#snapshots.set(key, {
          source: snapshot.source,
          cwd: snapshot.cwd,
          stamp: snapshot.stamp,
        });
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

  /**
   * Detect filesystem generations; a known content change also retires URI snapshots without stamps.
   * Pending mutation handles survive invalidation so their committed spans can still be confirmed.
   */
  public refresh(source: string, cwd: string, changed = false): void {
    const identity = sourcePath(source, cwd);
    const key = JSON.stringify([path.resolve(cwd), identity]);
    const stamp = fileStamp(source, cwd);
    const previous = this.#snapshots.get(key);
    // Live session results stay current by design, so input sent to them never retires the result.
    const edited = changed && !liveResource.test(source);
    if (edited || (previous && previous.stamp !== stamp)) {
      const content = this.#retire(identity, stamp);
      this.#snapshots.set(key, {
        source,
        cwd,
        stamp,
        ...(content === undefined ? {} : { content }),
      });
    } else this.#snapshots.set(key, { ...previous, source, cwd, stamp });
  }

  /** Check surviving snapshots at a script boundary, including final formatting. */
  public refreshAll(): void {
    for (const snapshot of [...this.#snapshots.values()])
      this.refresh(snapshot.source, snapshot.cwd);
  }
  /**
   * A source changed. A local file keeps every selection whose lines are all unchanged and moves it
   * to its new position. A selection with changed lines moves to the same region of the new text and
   * is marked `adjusted`: Search may use it, an edit may not. It is retired when none of its lines
   * survive, and so is any selection of another kind of source.
   */
  #retire(identity: string, stamp: string | undefined): string | undefined {
    const next = stamp === undefined ? undefined : readLocalText(identity);
    if (next === undefined) {
      this.invalidate(identity);
      return undefined;
    }
    const maps = new Map<string, LineMap | undefined>();
    let lines: readonly string[] | undefined;
    const newLines = () => (lines ??= next.split("\n"));
    const removed = new Set<string>();
    const rebased = new Set<string>();
    for (const [reference, entry] of this.#entries) {
      if (entry.state !== "ready") continue;
      let touches = false;
      const lost: string[] = [];
      const targets: ResultSourceTarget[] = [];
      for (const target of entry.targets) {
        if (sourcePath(target.source, entry.cwd) !== identity) {
          targets.push(target);
          continue;
        }
        touches = true;
        if (target.expectedContent === next) {
          targets.push(target);
          continue;
        }
        if (!maps.has(target.expectedContent))
          maps.set(target.expectedContent, createLineMap(target.expectedContent, next));
        const map = maps.get(target.expectedContent);
        const ranges: ResultRange[] = [];
        for (const range of target.ranges) {
          const moved = map === undefined ? undefined : moveRange(range, map, newLines);
          if (moved === undefined) lost.push(describeLostRange(range, map));
          else ranges.push(moved);
        }
        targets.push({ ...target, expectedContent: next, ranges });
      }
      if (!touches) continue;
      if (lost.length === 0) {
        this.#entries.set(reference, { ...entry, targets: combineTargets(targets) });
        rebased.add(reference);
      } else {
        // Keep a marker: the next use reports what changed instead of "expired or unknown".
        this.#entries.set(reference, {
          state: "rejected",
          cwd: entry.cwd,
          reason: retiredReason(lost),
        });
        removed.add(reference);
      }
    }
    for (const [key, shared] of this.#contents)
      if (shared.identity === identity) this.#contents.set(key, { identity, content: next });
    for (const [id, result] of this.#results)
      // A result whose selections moved, or were marked as changed, stays: its next use then
      // reports exactly what changed.
      if (
        result.resources.some((resource) => sourcePath(resource, result.cwd) === identity) &&
        !result.references.some((reference) => rebased.has(reference) || removed.has(reference))
      )
        this.#results.delete(id);
    return next;
  }

  /**
   * Put new selections of a local file on the text its other selections use: the file's text at
   * its current stamp. A caller may register a selection from a text it read earlier, such as a
   * search whose matches are registered one by one while another session writes the file. Such a
   * selection is moved like on a file change; `lost` describes the ranges whose own text changed.
   */
  #align(
    targets: readonly ResultSourceTarget[],
    cwd: string,
  ): { readonly targets: ResultSourceTarget[]; readonly lost: string[] } {
    const lost: string[] = [];
    const aligned = targets.map((target) => {
      const identity = sourcePath(target.source, cwd);
      const snapshot = this.#snapshots.get(JSON.stringify([path.resolve(cwd), identity]));
      if (snapshot?.stamp === undefined || liveResource.test(target.source)) return target;
      snapshot.content ??= readLocalText(identity);
      const current = snapshot.content;
      if (current === undefined) return target;
      // Equal strings compare in constant time only when they are the same object.
      if (target.expectedContent === snapshot.alias || target.expectedContent === current) {
        snapshot.alias = target.expectedContent;
        return { ...target, expectedContent: current };
      }
      if (snapshot.older?.text !== target.expectedContent)
        snapshot.older = {
          text: target.expectedContent,
          map: createLineMap(target.expectedContent, current),
        };
      const map = snapshot.older.map;
      let lines: readonly string[] | undefined;
      const ranges: ResultRange[] = [];
      for (const range of target.ranges) {
        const moved =
          map === undefined
            ? undefined
            : moveRange(range, map, () => (lines ??= current.split("\n")));
        if (moved === undefined) lost.push(describeLostRange(range, map));
        else ranges.push(moved);
      }
      return { ...target, expectedContent: current, ranges };
    });
    return { targets: aligned, lost };
  }

  /**
   * Check every file of the given entries once, before any of them is read. Refreshing per entry
   * would let a write that lands between two entries put them on different texts.
   */
  #refreshEntries(references: readonly string[], cwd: string): void {
    const sources = new Set<string>();
    for (const reference of references) {
      const entry = this.#entries.get(reference);
      if (entry === undefined)
        throw new Error("Result target expired or unknown; repeat Read/Search.");
      if (entry.cwd !== path.resolve(cwd))
        throw new Error("Result target belongs to another worktree.");
      if (entry.state === "pending")
        throw new Error("Result target is pending; its write has not been confirmed.");
      if (entry.state === "rejected") throw new Error(entry.reason);
      for (const target of entry.targets) sources.add(target.source);
    }
    for (const source of sources) this.refresh(source, cwd);
  }

  /** A refreshed entry; a changed file has moved its selections or retired it. */
  #current(reference: string, allowAdjusted: boolean): ResolvedResultTargets {
    const current = this.#entries.get(reference);
    if (current?.state === "rejected") throw new Error(current.reason);
    if (current?.state !== "ready")
      throw new Error("Result target expired after its snapshot changed; repeat Read/Search.");
    if (!allowAdjusted) {
      const adjusted = adjustedRegions(current.targets);
      if (adjusted.length > 0) throw new Error(retiredReason(adjusted));
    }
    return current;
  }

  /** Replace equal snapshot text with the copy already retained, so repeated results add no copy. */
  #shareContents(
    targets: readonly ResultSourceTarget[],
    cwd: string,
  ): readonly ResultSourceTarget[] {
    return targets.map((target) => {
      const identity = sourcePath(target.source, cwd);
      const key = JSON.stringify([path.resolve(cwd), identity]);
      const shared = this.#contents.get(key);
      if (shared?.content === target.expectedContent)
        return { ...target, expectedContent: shared.content };
      this.#contents.set(key, { identity, content: target.expectedContent });
      return target;
    });
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

/** One line per range that could not follow its file's change; long lists are cut, never hidden. */
function retiredReason(lost: readonly string[]): string {
  const shown = lost.slice(0, 10);
  const more = lost.length - shown.length;
  return [
    `Result target expired after its snapshot changed: ${String(lost.length)} selected range${lost.length === 1 ? "" : "s"} no longer match${lost.length === 1 ? "es" : ""} the file. Repeat Read/Search.`,
    ...shown.map((item) => `- ${item}`),
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
  ].join("\n");
}

/** Where the text of each adjusted range stands now, for the error of an edit that needs the old text. */
function adjustedRegions(targets: readonly ResultSourceTarget[]): string[] {
  return targets.flatMap((target) => {
    const adjusted = target.ranges.filter((range) => range.adjusted === true);
    // Splitting a large file costs about a millisecond; most selections are not adjusted.
    if (adjusted.length === 0) return [];
    const lines = target.expectedContent.split("\n");
    return adjusted.map((range) => {
      const first = (lines[range.start.lineNumber - 1] ?? "").trim();
      const shown = first.length > 120 ? `${first.slice(0, 120)}…` : first;
      return `lines ${String(range.start.lineNumber)}–${String(range.end.lineNumber)} changed: now ${String(range.start.lineNumber)}| ${shown}`;
    });
  });
}

function sourcePath(source: string, cwd: string): string {
  const file = source.startsWith("raw:") ? source.slice(4) : source;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(file) && !file.startsWith("file:")) return file;
  if (file.startsWith("file:")) {
    try {
      return fileURLToPath(file);
    } catch {
      /* Unresolved protocol labels have no filesystem stamp. */
    }
  }
  return path.resolve(cwd, file);
}
function readLocalText(file: string): string | undefined {
  try {
    if (statSync(file).size > maxRebasedBytes) return undefined;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  } catch {
    return undefined;
  }
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
      current =
        target.readCurrent === undefined
          ? await readFile(target.source, { encoding: "utf8", signal })
          : await target.readCurrent(signal);
      signal?.throwIfAborted();
      contents.set(target.source, current);
    }
    if (current !== target.expectedContent)
      throw new Error("Result target is stale; repeat Read/Search.");
  }
}
/**
 * Align a resolved result with the text its sources have now, for a consumer that only reads. Each
 * target gets the current text and its ranges moved onto it; a range whose own lines changed keeps
 * its region and is marked `adjusted`. Fails when a region cannot be found any more.
 */
export async function currentResultTargets(
  result: ResolvedResultTargets,
  signal?: AbortSignal,
): Promise<ResolvedResultTargets> {
  const contents = new Map<string, string>();
  const targets: ResultSourceTarget[] = [];
  for (const target of result.targets) {
    signal?.throwIfAborted();
    let current = contents.get(target.source);
    if (current === undefined) {
      current =
        target.readCurrent === undefined
          ? await readFile(target.source, { encoding: "utf8", signal })
          : await target.readCurrent(signal);
      signal?.throwIfAborted();
      contents.set(target.source, current);
    }
    if (current === target.expectedContent) {
      targets.push(target);
      continue;
    }
    const map = createLineMap(target.expectedContent, current);
    let lines: readonly string[] | undefined;
    const ranges = target.ranges.map((range) =>
      map === undefined ? undefined : moveRange(range, map, () => (lines ??= current.split("\n"))),
    );
    if (ranges.some((range) => range === undefined))
      throw new Error(
        `The region this result selected can no longer be found in ${target.source}; repeat Read/Search.`,
      );
    targets.push({
      ...target,
      expectedContent: current,
      ranges: ranges.filter((range) => range !== undefined),
    });
  }
  return { targets: combineTargets(targets), complete: result.complete };
}

/** Tell a reader that a result's text changed and which regions of the current text were used. */
export function describeAdjustedRanges(
  result: ResolvedResultTargets,
  cwd: string,
): string | undefined {
  const regions = result.targets.flatMap((target) =>
    target.ranges
      .filter((range) => range.adjusted === true)
      .map((range) => {
        const { start, end } = range;
        const last =
          end.column === 0 && end.lineNumber > start.lineNumber
            ? end.lineNumber - 1
            : end.lineNumber;
        const prefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
        const name = target.source.startsWith(prefix)
          ? target.source.slice(prefix.length)
          : target.source;
        return `${name}:${start.lineNumber}-${last}`;
      }),
  );
  if (regions.length === 0) return undefined;
  const shown = regions.slice(0, 5).join(", ");
  const more = regions.length > 5 ? ` and ${regions.length - 5} more` : "";
  return `The result's text changed after it was issued. Searched the current text of the same region (${shown}${more}); matches are anchored to the current file.`;
}

function combineTargets(targets: readonly ResultSourceTarget[]): ResultSourceTarget[] {
  const grouped = new Map<
    string,
    {
      source: string;
      expectedContent: string;
      ranges: ResultRange[];
      seen: Set<string>;
      readCurrent?: ResultSourceTarget["readCurrent"];
    }
  >();
  for (const target of targets) {
    const previous = grouped.get(target.source);
    if (previous !== undefined && previous.expectedContent !== target.expectedContent)
      throw new Error("Result targets refer to different snapshots of the same source.");
    const combined = previous ?? {
      source: target.source,
      expectedContent: target.expectedContent,
      ...(target.readCurrent === undefined ? {} : { readCurrent: target.readCurrent }),
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
