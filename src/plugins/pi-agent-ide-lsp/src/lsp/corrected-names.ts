import type { LspClient } from "./client.ts";
import { requestDiagnostics } from "./diagnostics.ts";
import { DiagnosticSeverity, type LspPosition, type LspRange } from "./types.ts";

/** A source position a server reported for a symbol, with the text written there. */
export interface ReportedName {
  readonly uri: string;
  readonly start: LspPosition;
  readonly text: string;
}

/** Errors a server reports for one document. */
export interface DocumentErrors {
  /** Starts of the error diagnostics, keyed by {@link positionKey}. */
  readonly starts: ReadonlySet<string>;
  /** The compiler reached its error limit and stopped reporting errors. */
  readonly stopped: boolean;
}

/** Errors of a document, or undefined when they are unavailable. */
export type DocumentErrorsProvider = (uri: string) => Promise<DocumentErrors | undefined>;

const IDENTIFIER = /^[\p{L}\p{Nl}_$][\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}$]*$/u;
const ERROR_LIMIT = /^fatal_too_many_errors$|too many errors emitted/iu;

/** Key of a position in {@link DocumentErrors.starts}. */
export function positionKey(position: LspPosition): string {
  return `${position.line}:${position.character}`;
}

/**
 * Drops the places where the compiler guessed the symbol for a misspelled name.
 *
 * Clang recovers from an undeclared name by binding it to a declared one within a small edit
 * distance and reports an error there; clangd then lists the misspelled name as a reference and
 * renames it. Such a place writes another identifier and has an error starting at it. Other
 * places whose text differs from the name, such as constructor calls at a variable, operators,
 * macro uses or attribute short names, have no error there and are kept.
 *
 * The correction that reaches clang's error limit gets no error of its own: clang reports the
 * limit instead and corrects nothing after it. In a document that reached the limit, a place
 * without an error is dropped when it is within clang's typo distance of the name.
 *
 * Diagnostics are read only for documents with a place whose text differs from the name; when
 * they are unavailable the place is kept.
 */
export async function withoutCorrectedNames<T>(
  items: readonly T[],
  locate: (item: T) => ReportedName,
  names: readonly string[],
  errorsOf: DocumentErrorsProvider,
): Promise<T[]> {
  const parts = [...new Set(names.flatMap((name) => name.match(/[\p{L}\p{N}_$]+/gu) ?? []))];
  const kept: T[] = [];
  for (const item of items) {
    const { uri, start, text } = locate(item);
    if (!IDENTIFIER.test(text) || parts.includes(text)) {
      kept.push(item);
      continue;
    }
    const errors = await errorsOf(uri);
    const corrected =
      errors !== undefined &&
      (errors.starts.has(positionKey(start)) ||
        (errors.stopped && parts.some((part) => withinTypoDistance(text, part))));
    if (!corrected) kept.push(item);
  }
  return kept;
}

/** Clang's typo bound: a case-sensitive edit distance of at most a third of the typo, rounded up. */
export function withinTypoDistance(typo: string, name: string): boolean {
  const bound = Math.floor((typo.length + 2) / 3);
  if (Math.abs(typo.length - name.length) > bound) return false;
  let previous = Array.from({ length: name.length + 1 }, (_, index) => index);
  for (let row = 1; row <= typo.length; row++) {
    const current = [row];
    for (let column = 1; column <= name.length; column++)
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (typo[row - 1] === name[column - 1] ? 0 : 1),
      );
    previous = current;
  }
  return (previous[name.length] ?? Infinity) <= bound;
}

/** Text of an LSP range in `content`, or an empty string when the range does not fit it. */
export function textInRange(content: string, range: LspRange): string {
  const starts = [0];
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1))
    starts.push(index + 1);
  const offset = (position: LspPosition) => {
    const start = starts[position.line];
    return start === undefined ? undefined : start + position.character;
  };
  const from = offset(range.start);
  const to = offset(range.end);
  return from === undefined || to === undefined || to < from ? "" : content.slice(from, to);
}

/**
 * Documents among `uris` where the compiler stopped at its error limit, in their first order.
 *
 * After clang reports its error limit it stops instantiating templates and no longer builds a
 * correct syntax tree. Code after the limit that needs a new instantiation, such as a loop over a
 * container type first used there, then has no references, and clang reports no error there.
 * References from such a document can be missing.
 *
 * Only the diagnostics the server already published for the current text are read, so the check
 * waits for nothing. Clangd publishes them for a text before it answers requests on its tree;
 * servers without an error limit never report one.
 */
export function documentsPastErrorLimit(
  client: Pick<LspClient, "diagnosticPublication">,
  uris: Iterable<string>,
): string[] {
  return [...new Set(uris)].filter((uri) =>
    (client.diagnosticPublication(uri)?.diagnostics ?? []).some(
      (diagnostic) =>
        diagnostic.severity === DiagnosticSeverity.Error &&
        (ERROR_LIMIT.test(String(diagnostic.code ?? "")) || ERROR_LIMIT.test(diagnostic.message)),
    ),
  );
}

/** Why a reference list from documents past the error limit can be incomplete. */
export function errorLimitNote(paths: readonly string[]): string {
  const files = paths.join(", ");
  return `Incomplete: the compiler stopped at its error limit in ${files}, so references after its first errors can be missing. Fix the errors (Read diagnostics:${paths[0]}) and search again, or search the text.`;
}

/** Errors from the current diagnostics of each document that `open` synchronizes, read once. */
export function diagnosticErrors(
  open: (
    uri: string,
  ) => Promise<{ client: LspClient; uri: string; languageId?: string } | null | undefined>,
  signal?: AbortSignal,
): DocumentErrorsProvider {
  const results = new Map<string, Promise<DocumentErrors | undefined>>();
  const read = async (uri: string): Promise<DocumentErrors | undefined> => {
    try {
      const document = await open(uri);
      if (!document) return undefined;
      const { diagnostics } = await requestDiagnostics(
        document.client,
        document.uri,
        document.languageId,
        { ...(signal && { signal }) },
      );
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      return {
        starts: new Set(
          errors.map((error) => positionKey({ line: error.line - 1, character: error.column - 1 })),
        ),
        stopped: errors.some(
          (error) => ERROR_LIMIT.test(error.code) || ERROR_LIMIT.test(error.message),
        ),
      };
    } catch (error) {
      // Without diagnostics no place is known to be a guess, so every place is kept.
      signal?.throwIfAborted();
      if (error instanceof Error) return undefined;
      throw error;
    }
  };
  return (uri) => {
    let result = results.get(uri);
    if (result === undefined) {
      result = read(uri);
      results.set(uri, result);
    }
    return result;
  };
}
