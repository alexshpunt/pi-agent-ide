---
name: find-prose-test-candidates
description: Search this repository's unit and integration tests for candidates that pin production prose, using Jev followed by agent review. Use only when the user explicitly requests this audit, not during ordinary test writing or linting.
---

# Find prose test candidates

This is manual, repository-local tooling. Jev finds possible problems; you decide whether each one is real. Do not enable lint/CI enforcement or rewrite tests as part of a search.

## Prepare the requested scope

Resolve the repository root three directories above this skill directory. Run commands from that root.

Read `scripts/dev/prose-candidates/README.md`, then inventory without making model requests:

```sh
pnpm exec oxnode scripts/dev/prose-candidates/run.ts
```

The command finds static unit and integration test declarations without filtering for prose or assertions. Check the reported volume and coverage issues. A test table is one declaration, not one request per row. Unsupported callbacks, oversized sources and files with no supported declarations need manual inspection.

Only run the scope the user requested. Before an unexpectedly large scan, explain the request volume and outbound source transfer and ask for approval. For a bounded check, use `--file PATH` and `--limit N`; this is not a complete repository audit.

## Run Jev explicitly

```sh
pnpm exec oxnode scripts/dev/prose-candidates/run.ts --live
```

Existing Pi authentication must expose a TypeSafe Jev classifier. Each selected test sends its declaration, callback and complete test file. Do not send files containing secrets. There is no automatic retry or cache; rerunning makes new requests. Provider pricing and model aliases can change.

Keep the printed run directory. Read its `run.json`, `candidates.json` and `candidates.md`. Candidate and unknown labels both enter the review queue. Model errors, pending tests and discovery gaps are unresolved coverage, not clean results.

## Review every queued item

For every candidate ID:
1. Read the current test and its saved source snapshot. If the source changed, rerun the affected scope.
2. Follow imports and helpers to the implementation, fixtures and any stated exact-text contract. Look at the specific assertions, not just the test name.
3. Ask whether a meaning-preserving edit to production prose would break an assertion while behavior stayed correct. Instruction/skill presence assertions also need inspection.
4. Distinguish caller-data preservation, parser fixtures, syntax, technical labels, error categories and actual text contracts from incidental production wording.
5. Record a judgement with source evidence. Jev probability is not proof.

Write `review.json` in that run directory, with exactly one item per candidate ID:

```json
[
  {
    "id": "ID_FROM_CANDIDATES",
    "verdict": "confirmed",
    "reason": "Explain which assertion pins incidental production wording.",
    "evidence": [{ "file": "repo/relative/file.ts", "line": 42 }]
  }
]
```

Use `confirmed`, `false-positive` or `needs-context`. State what is missing for unresolved cases; do not guess. Include implementation/helper evidence when the verdict depends on it. Do not invent model explanations.

## Check and report

```sh
pnpm exec oxnode scripts/dev/prose-candidates/check-review.ts RUN_DIRECTORY
```

The checker rejects missing, duplicate, unrelated, stale or evidence-free reviews. It checks coverage and evidence locations, not whether your judgement is correct.

Report confirmed cases, false positives and unresolved cases separately, with paths and lines. Disclose limited scans, errors, unsupported declarations and unfinished reviews. Even a complete scan cannot prove that clear model labels missed nothing. Do not silently skip a candidate or claim the repository is clean.

Do not edit existing tests unless the user separately requests fixes. Return findings in chat; opening a diff viewer is not required.
