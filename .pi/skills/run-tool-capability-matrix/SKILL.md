---
name: run-tool-capability-matrix
description: Run the pi-agent-ide paid real-model tool capability matrix, select cases and direct or native-Codemode routes, and report retained execution evidence. Use when asked to run the capability matrix, verify that a model can use IDE tools together, rerun affected routes, or inspect a capability run. Do not use for ordinary unit tests, model rankings, or implementing tool fixes.
---

# Run the tool capability matrix

Check whether a real model can execute the requested tool chains. A pass requires both the requested outcome and the actual route, including reuse of returned references. This is not a model ranking or a replacement for deterministic tool tests.

Resolve the repository root three directories above this skill directory. Run commands from that root. Read `benchmarks/tool-capabilities/README.md` for the runner's current requirements and evidence format; use the existing CLI, not a new harness.

## Prepare without inference

```sh
pnpm check:capabilities
pnpm validate:tools:models --list
```

Read `benchmarks/tool-capabilities/models.json` and the requested cases in `benchmarks/tool-capabilities/cases.ts`. Use `benchmarks/tool-capabilities/matrix.ts` to map requested capabilities to cases. Select only the requested scope. If the free gate fails, report the blocker; do not regenerate contracts or change cases just to make a run start.

Check Linux/WSL, Node 24, Git, Bubblewrap with user namespaces, installed Pi with native Codemode/tool discovery, and credentials. Check the selected cases' extra prerequisites. Never print or commit credentials. A successful free inventory does not prove that paid inference or every case's prerequisites are available.

## Agree on the paid run

Before inference, establish:

- Profile IDs and their provider/model/thinking settings.
- Case IDs, direct/Codemode routes, attempts per route, and timeout.
- Where results will be kept and whether a development worktree will later be removed.

Use `ask_user` for missing choices or cost permission. A model roster entry, a past task's permission, or a request to write this skill is not permission to spend. Use an explicit authorization already given for the current run; do not ask again without a new decision. If monetary cost is unknown, say so rather than inventing a price.

Show the planned command and attempt count before starting. Count selected supported routes × attempts × selected profiles; a Codemode-only case has no direct route. Omitting `--case` selects all cases; omitting `--mode` selects their supported routes. Retries are new paid attempts and need permission within the agreed limit.

## Run the existing CLI

Only after permission, adapt this bounded example to the agreed scope:

```sh
pnpm validate:tools:models --run --model luna-6-low \
  --case read-search-replace --mode codemode --attempts 1 --timeout 120
```

`--model` and `--case` accept comma-separated IDs. Use `--results NEW_DIRECTORY` when a specific destination was agreed; the directory must not already exist. Otherwise retain the newly printed directory under `.tmp/capability-results/`. Use `--pi /absolute/path/to/pi` only when an explicit installed runtime is needed.

Run one invocation at a time. Web/display fixtures use fixed local endpoints. Let the runner freeze the source, create fresh case clones, stop owned processes, and clean case state. Do not load personal extensions or weaken isolation to rescue a failed case. Do not use host windows for vision checks or run `git reset`/`git clean` on the checkout.

Use a background terminal for a long run and inspect its progress. If cancelled, stop the owned invocation and inspect the partial report. A nonzero exit is not a reason to retry automatically.

## Inspect the evidence

Read the run's `manifest.json`, `matrix.md`, and `attempts.json`. For failed or disputed attempts, inspect the linked result, JSONL execution events, tool errors, stderr, and fixture bytes when available. Check the actual model/thinking recorded by the observer. Do not infer a valid chain from tool names alone.

Keep these distinctions:

- `pass`: the required route and outcome were observed.
- `route_failed` or `outcome_failed`: the model did not complete the required contract.
- `model_error`, `infra_error`, `timed_out`, `cancelled`, or `unavailable`: no verified success; inspect the evidence before assigning a cause.
- Not run: unverified, not a pass.

Preserve every attempt. A later pass does not erase an earlier failure or prove reliability. Keep source digests separate; historical passes from different revisions are not one all-pass run of the current code. If a case or validator appears wrong, report the evidence and seek approval before changing it. Do not rewrite old statuses after a correction.

## Report and preserve

Return the source revision/digest, actual profiles, cases/routes, attempt counts, status counts, unverified routes, and paths to the evidence. State partial coverage and unknown causes plainly. Separate model noncompliance from evidenced tool/runtime failures. Propose follow-up work; do not fix production tools as part of a run.

Before deleting a development worktree, agree on storage. Preserve the accepted compact report with its source digest in the repository or task. Keep full raw evidence outside any worktree scheduled for removal, verify its archive hash, and record its location. Review raw files before sharing: they contain prompts, tool results, and images. Do not publish raw traces or discard them without approval.
