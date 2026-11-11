import { requiredValue } from "pi-agent-invariant";
import type { LspClient } from "./client.ts";
import type { DocumentErrorsProvider } from "./corrected-names.ts";

/** Languages clangd serves. */
export const CLANG_LANGUAGES: ReadonlySet<string> = new Set([
  "c",
  "cpp",
  "objective-c",
  "objective-cpp",
]);

/** The parts of a language server client that coverage checks use. */
export type ReachClient = Pick<LspClient, "serverId" | "rootUri" | "toUri" | "documentContent">;

/** The parts of the language server manager that coverage checks use. */
export interface ReachManager {
  filesContaining(
    client: ReachClient,
    word: string,
    languageIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined>;
  openFile(
    filePath: string,
    cwd: string,
    capability: "symbols",
    signal?: AbortSignal,
  ): Promise<{ readonly client: ReachClient } | null>;
}

/** Most files a query opens to read their references from a fresh parse. */
export const MAX_OPENED_FILES = 32;

/** Files a C/C++ query opened before asking for references. */
export interface ClangReach {
  readonly client: ReachClient;
  /** URIs of the opened files and of files that were already open, with the name in their text. */
  readonly opened: readonly string[];
  /** Files with the name in their text that were not opened, because of the limit. */
  readonly unopened: number;
  /** The workspace owner cannot list files by their text. */
  readonly unlisted: boolean;
}

/** What a C/C++ answer can be missing. */
export interface ClangCoverage {
  /** Fatal clang errors in files the answer depends on. */
  readonly fatal: readonly {
    readonly source: string;
    readonly line: number;
    readonly message: string;
  }[];
  /** Files with the name in their text whose references were not read from a fresh parse. */
  readonly unchecked: number;
  /** The workspace owner cannot list files by their text. */
  readonly unlisted: boolean;
}

/** The identifier a text search looks for: the last one in a name such as `~Widget`. */
function searchedWord(name: string): string | undefined {
  return name.match(/[\p{L}\p{N}_$]+/gu)?.at(-1);
}

/** Opens the workspace files that write a name; see {@link createClangReach}. */
export type ClangReachProvider = (
  client: ReachClient,
  languageId: string,
  name: string,
) => Promise<ClangReach | undefined>;

/**
 * Opens the workspace files whose text has a symbol's name, before a C/C++ reference query.
 *
 * clangd answers references of files that are not open from its background index. The index
 * parses each whole file, so a fatal error such as a missing `#include` drops every reference
 * after it, and the index lags behind edits made by other processes. An open file is parsed
 * again, keeps references after a missing `#include` in its header block and reports its errors.
 * Each opened file is parsed before the provider returns.
 *
 * One operation opens at most {@link MAX_OPENED_FILES} files for all its names together; the rest
 * are counted. Each name is looked up once. The provider returns undefined for other languages.
 */
export function createClangReach(input: {
  readonly manager: ReachManager;
  readonly cwd: string;
  readonly errorsOf: DocumentErrorsProvider;
  /** Files the operation may open; others are ignored. */
  readonly accepts?: (source: string) => boolean;
  readonly signal?: AbortSignal;
}): ClangReachProvider {
  const { manager, cwd, errorsOf, signal } = input;
  const reached = new Map<string, Promise<ClangReach>>();
  let newlyOpened = 0;
  const reach = async (client: ReachClient, word: string): Promise<ClangReach> => {
    const found = await manager.filesContaining(client, word, CLANG_LANGUAGES, signal);
    if (found === undefined) return { client, opened: [], unopened: 0, unlisted: true };
    const opened: string[] = [];
    let unopened = 0;
    for (const source of [...found].sort()) {
      signal?.throwIfAborted();
      if (input.accepts !== undefined && !input.accepts(source)) continue;
      const uri = client.toUri(source);
      if (client.documentContent(uri) === undefined) {
        if (newlyOpened >= MAX_OPENED_FILES) {
          unopened += 1;
          continue;
        }
        newlyOpened += 1;
        const document = await manager.openFile(source, cwd, "symbols", signal);
        if (document?.client !== client) continue;
      }
      opened.push(uri);
    }
    // Diagnostics arrive once a file is parsed, and clangd indexes an open file when it parses it.
    await Promise.all(opened.map((uri) => errorsOf(uri)));
    return { client, opened, unopened, unlisted: false };
  };
  return async (client, languageId, name) => {
    if (!CLANG_LANGUAGES.has(languageId)) return undefined;
    const word = searchedWord(name);
    if (word === undefined) return { client, opened: [], unopened: 0, unlisted: false };
    const key = JSON.stringify([client.serverId, client.rootUri, word]);
    let result = reached.get(key);
    if (result === undefined) {
      result = reach(client, word);
      reached.set(key, result);
    }
    return result;
  };
}

/**
 * The fatal errors of the open files an answer depends on: the declaration file, the opened files
 * and any other open file with a reference. Files whose diagnostics are unavailable count as
 * unchecked.
 */
export async function clangCoverage(
  reach: ClangReach,
  uris: Iterable<string>,
  errorsOf: DocumentErrorsProvider,
  sourceOf: (uri: string) => string,
): Promise<ClangCoverage> {
  const checked = [...new Set([...uris, ...reach.opened])].filter(
    (uri) => reach.client.documentContent(uri) !== undefined,
  );
  const errors = await Promise.all(checked.map((uri) => errorsOf(uri)));
  return {
    fatal: checked.flatMap((uri, index) =>
      (errors[index]?.fatal ?? []).map((error) => ({ source: sourceOf(uri), ...error })),
    ),
    unchecked: reach.unopened + errors.filter((item) => item === undefined).length,
    unlisted: reach.unlisted,
  };
}

/** Whether nothing can be missing from a C/C++ answer. */
export function coverageComplete(coverage: ClangCoverage | undefined): boolean {
  return (
    coverage === undefined ||
    (coverage.fatal.length === 0 && coverage.unchecked === 0 && !coverage.unlisted)
  );
}

/** Merge the coverage of several queries of one answer. */
export function mergeCoverage(
  items: readonly (ClangCoverage | undefined)[],
): ClangCoverage | undefined {
  const present = items.filter((item) => item !== undefined);
  if (present.length === 0) return undefined;
  const fatal = new Map<string, ClangCoverage["fatal"][number]>();
  for (const error of present.flatMap((item) => item.fatal))
    fatal.set(JSON.stringify([error.source, error.line, error.message]), error);
  return {
    fatal: [...fatal.values()],
    unchecked: Math.max(...present.map((item) => item.unchecked)),
    unlisted: present.some((item) => item.unlisted),
  };
}

/** Why a C/C++ answer can be missing references, one line per reason. */
export function coverageNotes(
  coverage: ClangCoverage | undefined,
  display: (source: string) => string,
): string[] {
  if (coverage === undefined) return [];
  const notes: string[] = [];
  if (coverage.fatal.length > 0) {
    const errors = coverage.fatal
      .map((error) => `${display(error.source)}:${error.line} ${error.message}`)
      .join("; ");
    const first = display(requiredValue(coverage.fatal[0]).source);
    notes.push(
      `Incomplete: clang stopped with a fatal error (${errors}), so references after it can be missing. Fix it (Read diagnostics:${first}) and search again, or search the text.`,
    );
  }
  if (coverage.unchecked > 0)
    notes.push(
      `Incomplete: ${coverage.unchecked} more file(s) contain the name and were not checked; search the text for their references.`,
    );
  if (coverage.unlisted)
    notes.push(
      "Incomplete: files that contain the name could not be listed, so references from files the server has not opened can be missing. Search the text.",
    );
  return notes;
}

/**
 * Why a C/C++ rename is refused, or undefined when nothing can be missing from it. A partial
 * rename leaves code that no longer compiles but looks finished.
 */
export function renameRefusal(
  coverage: ClangCoverage | undefined,
  display: (source: string) => string,
): string | undefined {
  if (coverageComplete(coverage) || coverage === undefined) return undefined;
  const reasons: string[] = [];
  if (coverage.fatal.length > 0) {
    const errors = coverage.fatal
      .map((error) => `${display(error.source)}:${error.line} ${error.message}`)
      .join("; ");
    reasons.push(
      `clang stopped with a fatal error (${errors}), so places after it can be missing from the rename. Fix it (Read diagnostics:${display(requiredValue(coverage.fatal[0]).source)}) and rename again.`,
    );
  }
  if (coverage.unchecked > 0)
    reasons.push(
      `${coverage.unchecked} more file(s) contain the name and were not checked, so the rename can miss them.`,
    );
  if (coverage.unlisted)
    reasons.push(
      "Files that contain the name could not be listed, so the rename can miss files the server has not opened.",
    );
  return `LSP rename refused; no edits applied. ${reasons.join(" ")} Or replace the text instead.`;
}
