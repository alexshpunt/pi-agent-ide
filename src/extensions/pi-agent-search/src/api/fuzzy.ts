import type { SearchSelectionMatch } from "#src/api/search.js";
import { fuzzyDataSchema, selectionData } from "#src/api/structured-result.js";
import { Value } from "typebox/value";

/** Fixed budgets for the extra branch, independent of ordinary Search's detail limit. */
export const fuzzyLimits = {
  candidates: 5,
  previewMatches: 3,
  identifiers: 20_000,
  identifierLength: 80,
  vocabularyBytes: 8 * 1024 * 1024,
  matchesPerCandidate: 200,
  verificationBytes: 4 * 1024 * 1024,
  timeoutMs: 2000,
} as const;
/** A spelling relation, never proof of equivalent behavior. */
export interface FuzzyIdentifier {
  readonly identifier: string;
  readonly kind: "normalized" | "component" | "typo";
  readonly reason: string;
}
/** Exact captured occurrences of one candidate in the original scope. */
export interface FuzzyCandidate extends FuzzyIdentifier {
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
}
/** Omit the branch entirely when no suggestions are available. */
export interface FuzzyResult {
  readonly status: "ready" | "skipped";
  readonly message?: string;
  readonly candidates: readonly FuzzyCandidate[];
}
/** A compact group usable by native script callers and existing Read. */
export interface FuzzyCandidateData extends FuzzyIdentifier {
  readonly matchCount: number;
  readonly fileCount: number;
  readonly selection: ReturnType<typeof selectionData>;
}

/** Registered or URL candidate groups, without backend state or source previews. */
export interface FuzzyResultData extends Omit<FuzzyResult, "candidates"> {
  readonly candidates: readonly FuzzyCandidateData[];
}
/** Validate saved renderer groups before reading their nested locations. */
export function isFuzzyResultData(value: unknown): value is FuzzyResultData {
  return Value.Check(fuzzyDataSchema, value);
}
/** Expand only a single unquoted ASCII identifier; keep explicit syntax exact. */
export function isFuzzyQuery(query: string): boolean {
  return (
    query.length >= 5 &&
    query.length <= fuzzyLimits.identifierLength &&
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(query) &&
    /[A-Za-z]/u.test(query)
  );
}
/** Hold unique spellings only. Input limits stop collection, not just the final ranking. */
export class FuzzyVocabulary {
  readonly names = new Set<string>();
  private bytes = 0;
  limited = false;

  /** Account stream bytes before retaining any new names. */
  account(bytes: number): boolean {
    this.bytes += bytes;
    if (this.bytes > fuzzyLimits.vocabularyBytes) this.limited = true;
    return !this.limited;
  }
  /** Add one complete lexical token; repeated occurrences do not grow the set. */
  add(identifier: string): void {
    if (this.limited || !isFuzzyQuery(identifier) || this.names.has(identifier)) return;
    if (this.names.size === fuzzyLimits.identifiers) {
      this.limited = true;
      return;
    }
    this.names.add(identifier);
  }
  /** Scan already fetched text without retaining occurrence records. */
  addText(text: string): void {
    if (!this.account(Buffer.byteLength(text))) return;
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
      this.add(match[0]);
      if (this.limited) break;
    }
  }
}
function splitName(name: string): string[] {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, index) => word === b[index]);
}
function oneTypo(a: string, b: string): boolean {
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1 || /\d/u.test(a + b))
    return false;
  let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index++;
  if (a.length === b.length) {
    return (
      a.slice(index + 1) === b.slice(index + 1) ||
      (a[index] === b[index + 1] &&
        a[index + 1] === b[index] &&
        a.slice(index + 2) === b.slice(index + 2))
    );
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return shorter.slice(index) === longer.slice(index + 1);
}
function relation(
  query: readonly string[],
  candidate: readonly string[],
): Omit<FuzzyIdentifier, "identifier"> | undefined {
  if (query.join("") === candidate.join(""))
    return { kind: "normalized", reason: "same spelling with different case or separators" };
  const shorter = query.length < candidate.length ? query : candidate;
  const longer = query.length < candidate.length ? candidate : query;
  if (
    longer.length === shorter.length + 1 &&
    shorter.length >= 2 &&
    shorter.every((word) => word.length >= 3)
  ) {
    const leading = same(shorter, longer.slice(1));
    const trailing = same(shorter, longer.slice(0, -1));
    if (leading || trailing)
      return {
        kind: "component",
        reason: `${query.length > candidate.length ? "remove" : "add"} ${leading ? "leading" : "trailing"} component '${leading ? longer[0] : longer.at(-1)}'`,
      };
  }
  if (query.length !== candidate.length) return undefined;
  const differences = query.flatMap((word, index) => {
    const other = candidate[index];
    return other !== undefined && word !== other ? [{ word, other }] : [];
  });
  const difference = differences[0];
  if (differences.length !== 1 || !difference || !oneTypo(difference.word, difference.other))
    return undefined;
  return {
    kind: "typo",
    reason: `one character edit: '${difference.word}' → '${difference.other}'`,
  };
}
const priority: Record<FuzzyIdentifier["kind"], number> = { normalized: 0, component: 1, typo: 2 };
/** Mix bounded spelling tiers, strongest first, with locale-independent stable ties. */
export function rankFuzzyIdentifiers(query: string, names: Iterable<string>): FuzzyIdentifier[] {
  if (!isFuzzyQuery(query)) return [];
  const parts = splitName(query);
  if (parts.length === 0) return [];
  const candidates: FuzzyIdentifier[] = [];
  for (const identifier of new Set(names)) {
    if (identifier === query || !isFuzzyQuery(identifier)) continue;
    const match = relation(parts, splitName(identifier));
    if (match) candidates.push({ identifier, ...match });
  }
  return candidates
    .sort(
      (a, b) =>
        priority[a.kind] - priority[b.kind] ||
        (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0),
    )
    .slice(0, fuzzyLimits.candidates);
}
/** Project exact candidate matches separately from the original zero result. */
export function fuzzyCandidateData(
  candidate: FuzzyCandidate,
  sessionId?: string,
): FuzzyCandidateData {
  return {
    identifier: candidate.identifier,
    kind: candidate.kind,
    reason: candidate.reason,
    matchCount: candidate.matches.length,
    fileCount: new Set(candidate.matches.map((match) => match.source)).size,
    selection: {
      ...selectionData(
        candidate.matches.slice(0, fuzzyLimits.previewMatches),
        candidate.complete,
        sessionId,
      ),
      truncated: candidate.matches.length > fuzzyLimits.previewMatches,
    },
  };
}
/** Render a compact possible-name group, not candidate source code or semantic claims. */
export function formatFuzzyCandidate(candidate: FuzzyCandidateData): string {
  const suffix = candidate.selection.complete ? "" : "+";
  const reference =
    candidate.selection.all?.line ?? candidate.selection.matches[0]?.references?.line;
  const first = candidate.selection.matches[0];
  const read = reference ?? first?.source;
  return [
    `Possible name: ${candidate.identifier} (${candidate.reason})`,
    `${candidate.matchCount}${suffix} ${candidate.matchCount === 1 && candidate.selection.complete ? "match" : "matches"} in ${candidate.fileCount}${suffix} ${candidate.fileCount === 1 && candidate.selection.complete ? "file" : "files"}`,
    `Exact alternative: ${JSON.stringify(candidate.identifier)} (case-sensitive, whole identifier)`,
    ...(candidate.selection.complete ? [] : ["Capture limit reached; no complete all reference."]),
    ...(read
      ? [`Read: ${read}${reference || !first ? "" : ` · line ${first.range.startLine}`}`]
      : []),
  ].join("\n");
}
