# Prose assertion lint experiment

This is a manual audit, not a rule enabled in normal lint or CI. It reports assertions worth reviewing; it does not prove they are bad and does not change tests.

## Run

From the repository root:

```sh
pnpm exec oxnode scripts/dev/prose-assertions/audit.ts
pnpm exec vitest run scripts/dev/prose-assertions.test.ts
```

The audit writes `.tmp/prose-assertions/findings.md` and `scan.json`. The Markdown report includes every location and assertion, sorted by file and line. Generated reports are ignored; rerun the audit to refresh them.

To see native lint diagnostics directly:

```sh
pnpm exec oxlint --config scripts/dev/prose-assertions/audit.config.ts .
```

Do not add `--deny-warnings` unless you want these review candidates to block the command. The separate config is not named `oxlint.config.ts`, so normal lint discovery does not pick it up.

## What it finds

- Prompt/document candidates: known getter and property names, simple immutable aliases, and recognized guide/document file-read paths. Any literal text assertion or snapshot can be reported, even a one-word marker.
- Broader wording candidates: strings, regexes, template text, and nested expected objects/arrays that look like prose. The heuristic looks for three words, or two words ending with sentence punctuation, and skips some obvious code/JSON/fence syntax. It supports Unicode letters but is not a language classifier.
- Positive and negative matchers, promise modifiers, computed matcher names, and direct string/regex predicates inside `expect`.

Assertion bindings are resolved for Vitest and Jest imports, including renamed imports. An unresolved global `expect` is accepted; a locally shadowed function is not.

## What it keeps and misses

Numbers, booleans, technical strings without prose patterns, and fixture forwarding comparisons are not blanket-banned. The broad scan does not expand expected-value identifiers, so input/output fixture comparisons remain valid. This also misses wording hidden in expected variables. Prompt-source comparisons can resolve a local expected constant.

False positives include tool labels and markup checked inside prompts, command syntax, exact fixture conversion/formatting, and phrases identifying an error category. Getter/property names and document paths are hints, not proof of production provenance. Even the prompt/document group needs review.

The prototype does not read imported prose files, trace arbitrary helper functions, analyze assertion code inside scripted strings, inspect external snapshot contents, or support every assertion library/matcher. It does not infer whether an agent follows an instruction. No autofix is offered: deleting or weakening a check can remove useful coverage.

## First repository scan

The scan found 440 assertions in 146 test files: 15 prompt/document candidates and 425 broader wording candidates. These are assertions, not distinct test cases. Default `pnpm lint` still passes, and no existing tests were rewritten.

Review of all 15 prompt/document candidates found:

- Five checks of instruction sentences: web search, code-review capture guidance, and IDE discovery guidance. Existing execution or structured exposure checks are better contracts.
- Three checks of code-review capture metadata or skill presence. These need a separate look at what loading/availability contract matters; they do not prove agent behavior.
- Seven checks of tool labels or markup. These are technical exposure/format checks, not prose-wording defects.

The broad list contains useful leads and clear false positives. No false-positive rate was measured for that group. Do not enable this rule automatically from its candidate count. The detailed results are linked from LPT-115 in Linear.
