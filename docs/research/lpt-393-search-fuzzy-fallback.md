# LPT-393: zero-result fuzzy Search verification

Search can now suggest nearby identifier spellings after a complete zero-result search. This is a spelling fallback, not semantic search. No model, new dependency, service, or persistent index is needed.

## How to use it

Call Search as usual with an unquoted identifier and a useful scope:

```js
search({ query: "generateHintStrings", path: "content_scripts/link_hints.js" });
```

The original result stays empty. On the pinned Vimium fixture, two separate groups follow:

- `hintStrings`: remove the leading `generate` component; 5 exact spans.
- `generateHintString`: one character edit; 2 exact spans.

These counts are occurrences, not implementations. Read the suggested source before deciding which name is relevant. Local groups provide their own Search references. Each all-reference repeats only that exact spelling if the files change, not the fuzzy ranking. Individual references become stale normally.

Inside native Codemode, the original `data.matches` remains empty. Use `data.fuzzy.candidates`, inspect each `selection.complete`, and read its `selection.all.line` when available. `selection.truncated` only describes the three-location public preview, not capture completeness. URL groups instead provide the requested URL and line ranges, with no editable Search references.

The fallback applies only to suitable unquoted ASCII identifiers, 5–80 characters long, after the ordinary search completes with zero results. Quoted queries, Boolean queries, explicit protocols, nonzero results, and incomplete searches keep their existing behavior. Ranking puts case/separator normalization first, one missing or extra edge component next, and one character edit last. Digits are not corrected. Suggestions do not claim synonyms or equivalent behavior.

## User TUI and agent results are separate

The local Search card now reports `0 exact · 10 fuzzy matches · 4 files` for the repository typo case. Below it, each candidate has a mechanical reason and a bounded source preview: file, line number and highlighted code. The preview uses at most three captured spans per name, with short context around the first highlighted span of each line. Shared source files count once in the header. Incomplete totals carry `+`; compact panels keep their expansion hint.

These previews are private renderer metadata, not agent-facing text or structured data. The agent still receives the original zero and separate exact candidate groups with Read references. URL results keep their existing URL/line output; this user-requested card revision changes the native local/repository panel.

The screenshot that showed only `No matches` came from restoring the older global renderer before merging this branch. That older renderer does not understand the new groups. Live verification uses the branch loader; global deployment still requires acceptance and merge.

## Bounds and freshness

Local collection streams unique names using the ordinary ripgrep scope and ignore/glob rules. It does not retain all occurrences just to build a vocabulary. Every invocation scans fresh names; there is no cache to invalidate after edits or checkout changes.

- At most 20,000 unique names and 8 MiB of name-stream input.
- At most 5 candidate groups.
- Exact verification captures at most 200 spans and 4 MiB of output per candidate.
- Collection and verification share a two-second deadline. Registration has a separate two-second phase budget and bounded snapshot reads.
- Source-size checks bound candidate snapshots to 8 MiB across the captured sources; registration and refresh also retain byte limits.
- Budget skips and extra-branch failures preserve the original zero and explain why suggestions are unavailable. Parent cancellation still aborts the call.
- Incomplete groups have no complete all-reference. A source race can leave readable locations without stable references; the result explains this.

URL search reuses the already fetched and converted body, with an 8 MiB content budget. It does not fetch the URL again for each candidate.

## Measured file and repository cases

Measured with Node 24.20.0 on this checkout. Each scope ran once, then five more times with a fresh name scan. Total time includes the ordinary search, vocabulary scan, exact verification, and reference registration. The ordinary backend was measured separately as a baseline.

| Scope / query                                | First total | Median of five repeats | Ordinary median | Node RSS before calls | Peak Node RSS |
| -------------------------------------------- | ----------: | ---------------------: | --------------: | --------------------: | ------------: |
| Pinned Vimium file / `generateHintStrings`   |    53.52 ms |               32.71 ms |         7.18 ms |            140.73 MiB |    152.41 MiB |
| Repository `src` / `planSearchPresentations` |   202.92 ms |              155.78 ms |        12.82 ms |            142.11 MiB |    247.20 MiB |

All six file runs returned the same 5/2 groups. All six repository runs returned `planSearchPresentation` with 10 exact spans. This repository case scans `src`, not every file in the repository.

The first call is not a flushed OS-cache measurement. RSS includes imported Node/runtime modules and process allocations, not just the vocabulary, and excludes child-process RSS. These are two measured cases, not a latency or memory guarantee for arbitrary repositories. Raw measurements: [file](lpt-393-fuzzy-results/file.json) and [repository](lpt-393-fuzzy-results/repo.json).

## Verification evidence

- 18 relevant unit files, 133 tests passed; focused type-aware lint passed.
- Four real-Pi integration files, 11 tests passed, covering fuzzy fallback, ordinary hybrid Search, web Search, and structured results. The two fuzzy integrations were rerun after the last renderer change and passed.
- Contracts cover query guards, scope/ignore rules, edits/removals/checkouts, byte and capture limits, cancellation, source races, bounded refresh, dollar identifier boundaries, typed results, and persisted rendering.
- Native local and URL Search plus native Codemode-to-Read were exercised after reloading the working extension. `hintStrings` Read returned four unique lines containing the five spans, including the method declaration at line 886.
- Actual `inspect_tui` captures of Herdr pane `w3GX:p1`, 123×108 cells, revision 147, live bottom: local groups showed both names, counts, reasons and locations without raw anchors or clipping. The URL compact result showed both names/counts and its expansion hint; remaining detail is available with Ctrl+O.
- After the user requested explicit fuzzy status and highlighted source previews, actual viewport captures of the same pane at revisions 606 and 635 showed the new `0 exact` header, distinct fuzzy/file totals, candidate names, file/line rows and highlighted code. Renderer persistence, bounded previews, partial totals, shared-file counting and isolation from agent output are covered by tests.
- Normal configured startup loaded exactly one IDE extension without errors or warnings, both with the temporary worktree loader and after restoring global loading. No model prompt was sent.
- Full source typecheck, package boundaries, machine-path check, catalog generation/check, public package build, and diff whitespace check passed.
- The effective Read/Search interface was exported and read completely. New workflow guidance lives in `docs:search-code`; callable parameter schemas are unchanged.

The temporary local settings/loader and local HTTP server were removed after verification. The global runtime was restored. The user explicitly accepted the feature after the live demo and a separate real-Pi recording of the card. Acceptance authorizes the PR into develop; it does not itself deploy the feature.

## Repeat the checks

```sh
pnpm exec vitest run src/extensions/pi-agent-search \
  src/extensions/pi-agent-read/extensions/pi-agent-web/test/search.test.ts
pnpm exec pi-test run -- pnpm exec vitest run --config vitest.integration.config.mjs \
  tests/integration/extensions/pi-agent-search/fuzzy-fallback.integration.test.ts
pnpm exec oxnode scripts/dev/check-normal-startup.ts
pnpm typecheck
pnpm check:boundaries
pnpm check:paths
pnpm docs:catalog
pnpm check:catalog
pnpm check:package
```

To repeat the measured cases, bundle the tracked profiler into the ignored temporary directory, then run each scope:

```sh
pnpm exec esbuild dev/performance/fuzzy-search.ts --bundle --platform=node \
  --format=esm --target=node24 --external:@earendil-works/* \
  --external:typebox --external:typebox/* --outfile=.tmp/fuzzy-verification/profile.mjs
node .tmp/fuzzy-verification/profile.mjs file
node .tmp/fuzzy-verification/profile.mjs repo
```
