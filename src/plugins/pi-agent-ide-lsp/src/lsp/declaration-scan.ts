import type { LspClient } from "./client.ts";
import type { ClangCoverage } from "./clang-coverage.ts";
import { textInRange } from "./corrected-names.ts";
import { isMethodNotFound } from "./errors.ts";
import type { LspManager } from "./manager.ts";
import { isMissingSource } from "./missing-sources.ts";
import type { LspCodeSymbol } from "./symbol-selectors.ts";
import type { LspWorkspaceSymbol } from "./symbols.ts";

/** Most files one search opens to read their declarations; the rest are reported as unchecked. */
export const MAX_SCANNED_FILES = 64;
const CONCURRENT_FILES = 8;

/** The identifier a query names exactly, or undefined for a fuzzy or multi-word query. */
export function exactIdentifier(query: string): string | undefined {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(query) ? query : undefined;
}

/** Declarations found by reading the files that write a name. */
export interface DeclarationScan {
  /** Declarations of the name per server that parsed their file, in workspace symbol form. */
  readonly declarations: ReadonlyMap<LspClient, readonly LspWorkspaceSymbol[]>;
  /** Files the scan could not check or list; present only when it is incomplete. */
  readonly coverage?: ClangCoverage;
}

const nothingChecked = { fatal: [], missingDiagnostics: [] } as const;

/**
 * Find the declarations of an exact name without asking the server's workspace index.
 *
 * A server fills that index from the projects it has loaded, and which projects those are depends
 * on the files it was shown first: one TypeScript project, one clangd compilation database, one
 * Go module. A text search lists the files under the scope that write the name; opening each one
 * lets its server pick the project that owns the file, and the file's own symbols name the
 * declarations. A file the scan did not open is reported, so the answer never claims a coverage
 * it did not check.
 */
export async function scanDeclarations(input: {
  readonly manager: Pick<LspManager, "filesContainingInScope" | "openFile">;
  readonly cwd: string;
  readonly roots: readonly string[];
  readonly word: string;
  /** Files the search may list. */
  readonly accepts: (source: string) => boolean;
  readonly readText: (source: string) => Promise<string>;
  readonly outlineOf: (client: LspClient, uri: string) => Promise<readonly LspCodeSymbol[]>;
  readonly signal?: AbortSignal;
}): Promise<DeclarationScan> {
  const { manager, cwd, word, signal } = input;
  const listings = await Promise.all(
    input.roots.map((root) => manager.filesContainingInScope(cwd, root, word, signal)),
  );
  const unlisted = listings.some((files) => files === undefined);
  const files = [...new Set(listings.flatMap((found) => found ?? []))]
    .filter((source) => input.accepts(source))
    .sort();
  const scanned = files.slice(0, MAX_SCANNED_FILES);
  const declarations = new Map<LspClient, LspWorkspaceSymbol[]>();
  const results: (readonly [LspClient, LspWorkspaceSymbol[]] | undefined)[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < scanned.length; index = next++) {
      signal?.throwIfAborted();
      const source = scanned[index] as string;
      try {
        results[index] = await declarationsIn(source);
      } catch (error) {
        // Deleted since the text search listed it: nothing in it to find.
        if (!isMissingSource(error)) throw error;
      }
    }
  };
  const declarationsIn = async (source: string) => {
    const opened = await manager.openFile(source, cwd, "symbols", signal, input.readText);
    if (opened === null || !opened.client.hasWorkspaceSymbolCapability) return undefined;
    const text = await input.readText(source);
    // A server without document symbols is searched through its workspace index alone.
    const outline = await input.outlineOf(opened.client, opened.uri).catch((error: unknown) => {
      if (isMethodNotFound(error)) return undefined;
      throw error;
    });
    if (outline === undefined) return undefined;
    const found: LspWorkspaceSymbol[] = [];
    const visit = (symbols: readonly LspCodeSymbol[]) => {
      for (const symbol of symbols) {
        // The name range holds the identifier even when the server decorates the symbol's name,
        // such as gopls with `(*Engine).Start` or clangd with a destructor's `~`.
        if (textInRange(text, symbol.selectionRange) === word)
          found.push({
            name: symbol.name,
            kind: symbol.kind,
            location: { uri: opened.uri, range: symbol.selectionRange },
          });
        visit(symbol.children);
      }
    };
    visit(outline);
    return [opened.client, found] as const;
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_FILES, scanned.length) }, () => worker()),
  );
  for (const result of results) {
    if (result === undefined) continue;
    declarations.set(result[0], [...(declarations.get(result[0]) ?? []), ...result[1]]);
  }
  const unchecked = files.slice(MAX_SCANNED_FILES);
  return {
    declarations,
    ...((unchecked.length > 0 || unlisted) && {
      coverage: { ...nothingChecked, unopened: unchecked, unlisted },
    }),
  };
}
