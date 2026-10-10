# Paid tool capability matrix

This checks whether a real model can execute our designed IDE operations and tool chains. It is not a model ranking, a reliability score, or a replacement for unit and integration tests.

Each short task names the required route. The model must choose the arguments, use actual returned references, and produce the requested result. We check both final bytes or observed values **and** real tool execution events. Calling the same tool names without reusing the required results does not pass.

## Free checks

```bash
pnpm check:capabilities
pnpm validate:tools:models --list
```

The coverage gate is part of `pnpm check`. It loads the current IDE without a prompt or model call, compares structural tool contracts, and checks links between the declared capabilities and executable cases. It includes deferred tools, not just initially active tools. Descriptions and other prompt wording are not snapshot-tested.

The free regression tests cover route provenance and sandbox timeout/reset/cleanup. One scripted real-Pi integration test proves that nested Codemode events are read correctly. These tests do not use paid models.

## Paid runs

Requirements: Linux or WSL, Node 24, Git, Bubblewrap with user namespaces enabled, installed Pi with native Codemode and tool discovery, and provider credentials. The free inventory prefers the globally installed Pi; without one it uses the checkout's SDK. `--pi /absolute/path/to/pi` selects an installed runtime explicitly. Paid runs need Pi and its dependencies inside the read-only system toolchain mounts (`/usr`, `/opt`, or the local bin/lib directories under the user home).

On Ubuntu, AppArmor may also need a profile that permits user namespaces for `/usr/bin/bwrap`. CI loads that per-binary profile if a sandbox launch is blocked, then checks a real launch with user and PID namespaces. It does not disable the runner-wide restriction. See [Ubuntu's user namespace policy](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).

```bash
pnpm validate:tools:models --run --model luna-6-low
pnpm validate:tools:models --run --model luna-6-low \
  --case read-search-replace --mode codemode --attempts 2 --timeout 120
```

No inference happens without both `--run` and an explicit model profile. The command is separate from ordinary tests and CI. Obtain permission for the selected provider, model, thinking level, and runs before using it. Being in `models.json` is not permission to spend.

Profiles use the Explicit Edit Benchmark registry as a starting point; Luna 6 low was added by explicit task approval. New models belong in `models.json`, not in case definitions. Use the same tasks and validators for each model.

Most cases have direct and Codemode routes. Cross-call `store`/`load` is Codemode-only. Cases are deliberately small: a representative route for each declared capability, not every Cartesian combination of tools, platforms, language servers, or debug adapters.
Directory/link transfer cases cover the shared local policy and refusal to reuse an object receipt as text. SSH owner pairs are checked by focused integration cases; these paid cases do not prove paid SSH coverage. Unrun direct and Codemode routes remain unverified.

Temporary Delete cases likewise check the shared defaults and settings contract locally. Target-native account/config resolution is checked by transport tests, not a paid SSH case. Paid SSH temporary-deletion routes remain unverified.
The `ssh-guide` case checks that Read exposes SSH setup guidance before any target is configured. It does not verify connection setup, reload, or remote operations. Its direct and Codemode routes remain unverified until a paid run.

## Isolation

A run freezes the checkout's current source and dependencies in a disposable clone and records its revision and source digest. Each case gets a fresh clone, fixture directory, private Pi home, and process namespace. Only that case's workspace/state and sandbox temporary directories are writable. Source and system tools are read-only; host checkouts, personal context, extensions, skills, and MCP configuration are not loaded.

Network access is shared for inference and local web fixtures. This is **not** network isolation or a sandbox for hostile code. Credentials are copied into private case state and removed with it. Child process groups are stopped on timeout/cancellation. Cleanup never runs `git reset` or `git clean` on the development checkout.

Media, browser, display, LSP, and debug cases need their own system prerequisites. Missing prerequisites produce `unavailable`, never a pass. Window/display checks use a sandbox-owned Xvfb display, not host windows. Display and web setup use fixed local endpoints; do not run those cases concurrently.

## Evidence

Each invocation creates a new directory under `.tmp/capability-results/`, or a new directory selected with `--results`. Existing directories are not overwritten.

- `matrix.md`: capability × model/route evidence with links to every attempt.
- `manifest.json`: live inventory, selected profiles/cases, base revision, source digest, timeout.
- `attempts.json`: all attempts, including failures.
- Per attempt: prompt, JSONL events, stderr, actual model/thinking and system prompt, initial/final fixture bytes (`files.json`, Base64), result, and tool errors when execution reached validation.

`pass` means the required route and outcome were observed. `route_failed`, `outcome_failed`, `model_error`, `infra_error`, `timed_out`, `cancelled`, and `unavailable` remain distinct. Not run is not a pass. A later success does not erase earlier failures. An observed pass proves executability once, not consistency across runs.

Reports are written after each attempt and preserved on cancellation. Case workspaces and credentials are removed even when a case fails. Review evidence before sharing it: it includes prompts and tool results. Preserve the accepted report and source digest with the task before removing the development worktree. Results from different source digests must not be presented as one run of the same code.

The initial suite verification and retained findings are in [LPT-655 evidence](evidence/LPT-655.md). That report separates historical source digests and leaves incomplete routes unverified.

The focused native Codemode semantic rename fix and its direct/Codemode rerun are in [LPT-660 evidence](evidence/LPT-660.md). These results do not replace the earlier failed attempts.

The 0.8.1 editing checks are in [LPT-698/699/704/705 evidence](evidence/LPT-698-699-704-705.md). They include deterministic real-Pi replay and free coverage checks, not paid model results. `parallelWith` requires overlapping child execution in the same native Codemode script; sequential calls cannot pass the parallel route.

The current tooling checks are in [LPT-708/710/711 evidence](evidence/LPT-708-710-711.md). They separate deterministic regressions, current-session live/TUI checks, the retained initial live failure and unrun paid routes. Final transcript feedback can differ from an earlier execution-end validation event; both stay in the evidence.

The intercepted-feedback and release-hygiene follow-up is in [LPT-715 evidence](evidence/LPT-715.md). Its real-Pi checks cover both the finalized message and the provider boundary. The paid stale-feedback case has a finalized UTF-8 byte limit; this does not claim paid coverage of the oversized provider-boundary reproduction.

## Required maintenance

When an IDE tool or a supported composition changes:

1. Review `matrix.ts`. Add, update, or remove the intended capability entries.
2. Update the linked tasks in `cases.ts`, including their route and outcome checks. Include every required source/destination reference, not just one endpoint.
3. Run the free gate and affected free regression tests.
4. If the tool schema changed, review the cases first, then explicitly record the new contracts:

   ```bash
   pnpm validate:tools:models --record-contracts
   pnpm check:capabilities
   ```

5. With paid permission, run the affected routes and preserve both failures and successes. Leave unrun routes unverified.

The schema gate detects structural drift and broken coverage links. It cannot infer semantic completeness or detect every behavior change from code. Do not just regenerate `contracts.json` to bypass a failure; the matrix/case review is mandatory even when the schema stays unchanged.
