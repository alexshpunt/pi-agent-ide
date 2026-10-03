import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  FuzzyVocabulary,
  fuzzyLimits,
  rankFuzzyIdentifiers,
  type FuzzyResult,
  type FuzzyCandidate,
} from "pi-agent-search/api/search";
import { ripgrepScope, searchText, type TextSearchRequest } from "#src/search-backend.js";
import { resolveRipgrepExecutable } from "#src/ripgrep.js";

/** Scan fresh names, then capture only bounded exact alternatives in the same scope. */
export async function searchFuzzy(
  request: TextSearchRequest,
  cwd: string,
  parent?: AbortSignal,
): Promise<FuzzyResult | undefined> {
  const deadline = AbortSignal.timeout(fuzzyLimits.timeoutMs);
  const signal = parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
  try {
    signal.throwIfAborted();
    const vocabulary = await collectNames(request, cwd, signal);
    if (vocabulary.limited)
      return skipped("name collection reached its byte or unique-name budget");
    const candidates: FuzzyCandidate[] = [];
    let snapshotBytes = 0;
    const sources = new Set<string>();
    for (const name of rankFuzzyIdentifiers(request.query, vocabulary.names)) {
      signal.throwIfAborted();
      const result = await searchFuzzyAlternative(
        { ...request, query: name.identifier },
        cwd,
        signal,
      );
      if (result.matches.length === 0) {
        if (!result.complete)
          return skipped("candidate verification reached its byte budget before capturing a match");
        continue;
      }
      for (const match of result.matches) {
        if (sources.has(match.source)) continue;
        sources.add(match.source);
        snapshotBytes += (await stat(match.source)).size;
        if (snapshotBytes > fuzzyLimits.vocabularyBytes)
          return skipped("candidate source snapshots exceeded the byte budget");
      }
      candidates.push({ ...name, ...result });
    }
    return candidates.length === 0 ? undefined : { status: "ready", candidates };
  } catch (error) {
    parent?.throwIfAborted();
    return skipped(
      deadline.aborted
        ? "extra search reached its time budget"
        : `extra search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
/** Replay only a candidate's exact spelling, with the same capture and time bounds. */
export async function searchFuzzyAlternative(
  request: TextSearchRequest,
  cwd: string,
  parent?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(fuzzyLimits.timeoutMs);
  const signal = parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
  const result = await searchText(
    { ...request, regex: false, caseSensitive: true, wholeWord: true },
    cwd,
    signal,
    { matches: fuzzyLimits.matchesPerCandidate, bytes: fuzzyLimits.verificationBytes },
  );
  // ripgrep's word boundary includes letters/digits/underscore, but treats dollar as punctuation.
  return {
    ...result,
    matches: result.matches.filter(
      (match) =>
        match.lineText[match.startColumn - 1] !== "$" && match.lineText[match.endColumn] !== "$",
    ),
  };
}
function skipped(message: string): FuzzyResult {
  return { status: "skipped", message, candidates: [] };
}

async function collectNames(
  request: TextSearchRequest,
  cwd: string,
  signal: AbortSignal,
): Promise<FuzzyVocabulary> {
  const scope = await ripgrepScope(request, cwd);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveRipgrepExecutable(),
      [
        "--only-matching",
        "--no-filename",
        "--case-sensitive",
        ...scope.arguments,
        "--",
        "[A-Za-z_$][A-Za-z0-9_$]*",
        scope.target,
      ],
      { cwd: scope.cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const vocabulary = new FuzzyVocabulary();
    let token = "";
    let oversized = false;
    let stderr = "";
    const abort = (): void => {
      child.kill();
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!vocabulary.account(chunk.length)) {
        child.kill();
        return;
      }
      // ASCII tokens only: keep at most 80 bytes across stream chunks, not full lines.
      for (const byte of chunk) {
        if (byte === 10) {
          if (!oversized) vocabulary.add(token);
          token = "";
          oversized = false;
          if (vocabulary.limited) {
            child.kill();
            break;
          }
        } else if (!oversized) {
          if (token.length === fuzzyLimits.identifierLength) {
            token = "";
            oversized = true;
          } else token += String.fromCharCode(byte);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 4096);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (!vocabulary.limited && code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`));
        return;
      }
      resolve(vocabulary);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
