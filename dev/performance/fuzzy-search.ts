import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTextResolver } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/resolvers.js";
import {
  createSearchRecipe,
  runSearchRecipe,
} from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/search-recipe.js";
import { SearchSessionStore } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/search-session.js";
import { isFuzzyResultData } from "pi-agent-search/api/search";

/** Measure the real resolver, formatting and ordinary backend, without model calls or an index. */
const scope = process.argv[2] ?? "file";
if (scope !== "file" && scope !== "repo") throw new Error("Use file or repo scope.");
const request =
  scope === "file"
    ? {
        query: "generateHintStrings",
        path: "tests/integration/extensions/pi-agent-search/fixtures/fuzzy-vimium/link_hints.js",
      }
    : { query: "planSearchPresentations", path: "src" };
const context = { cwd: process.cwd() };
const resolver = createTextResolver(new SearchSessionStore());
const before = process.memoryUsage();
const runs = [];
for (let repetition = 0; repetition < 6; repetition++) {
  const start = performance.now();
  const attempt = await resolver.tryResolve(request, context);
  const resolved = performance.now();
  if (attempt.kind !== "resolved")
    throw new Error("Expected the real text resolver to handle the query.");
  const formatted = await resolver.format(attempt.payload, context);
  const finished = performance.now();
  const projected = resolver.toScriptData?.(attempt.payload, formatted.details);
  if (
    typeof projected !== "object" ||
    projected === null ||
    !("matches" in projected) ||
    !Array.isArray(projected.matches) ||
    projected.matches.length !== 0
  )
    throw new Error("Expected an ordinary zero result.");
  const fuzzy =
    "fuzzy" in projected && isFuzzyResultData(projected.fuzzy) ? projected.fuzzy : undefined;
  const ordinaryStart = performance.now();
  await runSearchRecipe(createSearchRecipe(request), context.cwd);
  const memory = process.memoryUsage();
  runs.push({
    repetition,
    invocation: repetition === 0 ? "first in this process" : "repeat; fresh name scan",
    resolveMs: resolved - start,
    registrationMs: finished - resolved,
    totalMs: finished - start,
    ordinaryMs: performance.now() - ordinaryStart,
    status: fuzzy?.status ?? "no candidates",
    message: fuzzy?.message,
    candidates: fuzzy?.candidates.map(({ identifier, matchCount, selection }) => ({
      identifier,
      matchCount,
      complete: selection.complete,
    })),
    rssBytes: memory.rss,
    heapBytes: memory.heapUsed,
  });
}
const output = {
  scope,
  request,
  node: process.version,
  baselineRssBytes: before.rss,
  baselineHeapBytes: before.heapUsed,
  peakNodeRssKiB: process.resourceUsage().maxRSS,
  runs,
  note: "First invocation is not a flushed OS cache. Resolve includes ordinary search, name collection and exact verification. Registration includes bounded snapshots. RSS includes imported runtime modules; it is not the vocabulary size and does not include child-process RSS.",
};
const destination = path.resolve(".tmp/fuzzy-verification", scope + ".json");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
console.log("Saved " + destination);
