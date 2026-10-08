# Prose test candidate search

Manual tooling for this repository. Jev searches unit and integration test declarations; an agent reviews every candidate and unknown result. It does not decide defects or enforce lint rules.

## Run

Install the repository dependencies and use existing Pi authentication for a TypeSafe Jev classifier.

```sh
# Inventory only: no authentication needed and no model requests.
pnpm exec oxnode scripts/dev/prose-candidates/run.ts

# Explicit full scan, only when the user requests it.
pnpm exec oxnode scripts/dev/prose-candidates/run.ts --live

# Bounded verification. --file can be repeated.
pnpm exec oxnode scripts/dev/prose-candidates/run.ts --live --file src/code-review/config.test.ts --limit 3

# After the agent writes review.json in the printed run directory.
pnpm exec oxnode scripts/dev/prose-candidates/check-review.ts .tmp/prose-candidates/RUN
```

The project skill is `.pi/skills/find-prose-test-candidates/SKILL.md`. Ask an agent to search for prose-coupled test candidates and review every result.

## What is scanned

Git-visible tracked and unignored test/spec files in JS/TS, including unit and integration directories. Generated output, fixture directories and agent configuration directories are excluded. Vitest, Jest globals and node:test declarations are recognized, including import aliases, namespaces, inline/named callbacks and factory forms such as test.each.

Every supported static declaration is considered, even without string assertions. Parameter tables and conditional factories are not executed or expanded. Runtime-generated tests and custom wrappers may need manual inspection. Missing callbacks, syntax errors, sources over 60,000 characters and files without supported declarations are reported as coverage gaps. The character bound is a local safety limit, not a provider token guarantee.

Each request includes the selected declaration, callback and complete test file, not imported implementations. Test names, comments and fixture strings are evidence, not instructions. Jev returns candidate, clear or unknown. Candidate and unknown results enter the agent queue; neither is a confirmed defect.

## Safety and output

Preparation makes zero requests. Live mode sends source to TypeSafe using the Pi model runtime. Review secrets and request volume first. Calls are sequential with a 30-second timeout and stop on the first invalid/provider-error result. There is no automatic retry or cache; a rerun costs new requests. A catalog price of zero is not proof of free billing.

Each run gets a new ignored `.tmp/prose-candidates/RUN` directory with:

- `run.json`: scope, coverage gaps, selected declarations, question and raw replies.
- `sources/`: full source snapshots.
- `candidates.json` and `candidates.md`: the review queue.
- `review.json`: agent-written judgements, following the skill's format.

The checker requires exactly one evidence-backed judgement for every queued ID, checks candidate source hashes and evidence file/line locations, and prints confirmed/false-positive/needs-context counts. It cannot prove a judgement true. Candidate hashes cover test files, not every imported dependency; reviewers must inspect current helper implementations.

A limited, failed or prepared-only run is never reported as a complete repository scan. Clear labels can be false negatives. Keep unresolved coverage separate from reviewed candidates. This tool does not change tests, default lint, CI or package scripts.
