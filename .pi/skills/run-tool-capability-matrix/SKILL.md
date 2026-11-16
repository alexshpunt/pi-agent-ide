---
name: run-tool-capability-matrix
description: Run the pi-agent-ide paid real-model tool capability matrix, select cases and direct or native-Codemode routes, and report retained execution evidence. Use when asked to run the capability matrix, verify that a model can use IDE tools together, rerun affected routes, or inspect a capability run. Do not use for ordinary unit tests, model rankings, or implementing tool fixes.
---

# Run the tool capability matrix

Check whether agents and models can carry out the tools' contracts without surprises, given a precise, complete and unambiguous task with every dependent value supplied. Do not test whether a model guesses the intended task or preferred arguments. A pass requires both the requested outcome and the actual capability route, including required reuse and refusals. This is not a model ranking or a replacement for deterministic tool tests.

Resolve the repository root three directories above this skill directory. Run commands from that root. Read `benchmarks/tool-capabilities/README.md` for the runner's current requirements and evidence format; use the existing CLI, not a new harness.

## Prepare without inference

```sh
pnpm check:capabilities
pnpm validate:tools:models --list
```

Read `benchmarks/tool-capabilities/models.json` and the requested cases in `benchmarks/tool-capabilities/cases.ts`. Use `benchmarks/tool-capabilities/matrix.ts` to map requested capabilities to cases. Select only the requested scope. If the free gate fails, report the blocker; do not regenerate contracts or change cases just to make a run start.

Check Linux/WSL, Node 24, Git, Bubblewrap with user namespaces, installed Pi with native Codemode/tool discovery, and credentials. Check the selected cases' extra prerequisites; the README's "Case prerequisites" section lists them and how to install them where the sandbox sees them. Never print or commit credentials. A successful free inventory does not prove that paid inference or every case's prerequisites are available.

## Plan the paid run

Cost permission and credentials follow the user's `paid-model-runs` skill. Its routes (the OpenAI subscription and cheap OpenCode Go models) need no further approval; ask with `ask_user` only for other providers or models. If monetary cost is unknown, say so rather than inventing a price.

Before inference, settle:

- Profile IDs and their provider/model/thinking settings. Add a missing profile to `benchmarks/tool-capabilities/models.json`.
- Case IDs, direct/Codemode routes, attempts per route, and timeout. Default to the affected cases and one attempt per route.
- Where results will be kept and whether a development worktree will later be removed. Keep them outside a worktree that will be removed.

Count selected supported routes × attempts × selected profiles; a Codemode-only case has no direct route. Omitting `--case` selects all cases; omitting `--mode` selects their supported routes. Retries are new paid attempts; inspect a failure before repeating it.

The runner refuses the personal `~/.pi/agent/auth.json`. Pass `--auth-dir` with the private snapshot directory that `paid-model-runs` describes, without `--dedicated-auth`, so the runner uses the access token without refreshing it. The directory must contain `auth.json` itself: on ZinPC, `~/.pi/paid-run-auth/openai-codex` holds only per-run subdirectories, and pointing at it makes every attempt `unavailable` before inference.

## Run the existing CLI

Adapt this bounded example to the planned scope:

```sh
pnpm validate:tools:models --run --model luna-6-low \
  --auth-dir ~/.pi/paid-run-auth/openai-codex/<run> \
  --case read-search-replace --mode codemode --attempts 1 --timeout 120
```

`--model` and `--case` accept comma-separated IDs. Use `--results NEW_DIRECTORY` when a specific destination was agreed; the directory must not already exist. Otherwise retain the newly printed directory under `.tmp/capability-results/`. Use `--pi /absolute/path/to/pi` only when an explicit installed runtime is needed.

Run parallel attempts within one invocation and one ZinPC worker job slot, not as separate invocations. Web fixtures share a fixed local port across invocations, so do not overlap invocations on the same host. Let the runner freeze the source, create fresh case clones, stop owned processes, and clean case state. Do not load personal extensions or weaken isolation to rescue a failed case. Do not use host windows for vision checks or run `git reset`/`git clean` on the checkout.

Use `--concurrency N` only within the approved attempt and cost scope; the default is 1. A stop cancels active attempts, but requests already started may incur cost. Web fixtures serialize within the invocation; TUI and mutable dedicated authentication require concurrency 1.

For a whole-matrix run on ZinPC (16 cores, 15.5 GB RAM, 4 GB swap), use `--concurrency 25`. Measured on Terra 6.1 low: at 20 the run took 305 s with a memory peak of 11.6 GB and PSI some avg10 at most 2.2; at 30 it took 341 s, filled memory to 15.2 GB, used 1 GB of swap and reached PSI 13.7, without timeouts or extra failures. 25 is the agreed balance; drop to 20 if a run shows timeouts or memory pressure.

Use a background terminal for a long run and inspect its progress. If cancelled, stop the owned invocation and inspect the partial report. A nonzero exit is not a reason to retry automatically.

## Inspect the evidence

Read the run's `manifest.json`, `matrix.md`, and `attempts.json`. For failed or disputed attempts, inspect the linked result, JSONL execution events, tool errors, stderr, and fixture bytes when available. Check the actual model/thinking recorded by the observer. Do not infer a valid chain from tool names alone.

Keep these distinctions:

- `pass`: the required route and outcome were observed.
- `route_failed` or `outcome_failed`: the recorded route or outcome did not satisfy a check; this status alone does not identify the cause.
- `model_error`, `infra_error`, `timed_out`, `cancelled`, or `unavailable`: no verified success; inspect the evidence before assigning a cause.
- Not run: unverified, not a pass.

Classify each evidenced failure as a tool defect (a documented contract was broken), an unclear tool contract (a required fact was missing, such as units), or model noncompliance (an exact usable instruction was not followed). Inspect the supplied prompt and values before blaming the model. An ambiguous case or incidental-argument check is a bench false failure, not model noncompliance; report it separately and correct it only when the current task authorizes that work. Leave unavailable or insufficient evidence unverified.

Preserve every attempt. A later pass does not erase an earlier failure or prove reliability. Keep source digests separate; historical passes from different revisions are not one all-pass run of the current code. If a case or validator appears wrong, retain the evidence and report it; seek approval before changing it unless the current task already authorizes that correction. Follow the README's case-contract rule, not per-case spelling alternatives. Do not rewrite old statuses after a correction.

## Report and preserve

Return the source revision/digest, actual profiles, cases/routes, attempt counts, status counts, unverified routes, and paths to the evidence. State partial coverage and unknown causes plainly. Separate model noncompliance from evidenced tool/runtime failures. Propose follow-up work; do not fix production tools as part of a run.

Before deleting a development worktree, agree on storage. When durable results are required, attach the accepted report and its source digest to the corresponding Task. Never commit run reports or raw evidence to the repository. Keep full raw evidence outside any worktree scheduled for removal, verify its archive hash, and record its location. Review raw files before sharing: they contain prompts, tool results, and images. Do not publish raw traces or discard them without approval.
