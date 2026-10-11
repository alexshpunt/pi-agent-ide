# Feature PRs and checks

Deliver each feature through one minimal implementation PR to `develop`. Include implementation code and useful in-code API comments, but keep test changes and separate project documentation out of its diff.

Explain the problem and the chosen solution in the PR description. Link the Task and optionally include a brief check summary. Before requesting review, post useful inline GitHub comments on the current diff that identify important locations and what the user should check. Open the PR in the user's browser instead of showing GIF demonstrations.

Put required project documentation in a separate docs-only PR. Both implementation and documentation require explicit user approval of their own current head. If either head changes, request approval again. For documentation-only work, do not invent an implementation PR or artificial tests.

Write and run the relevant tests against the implementation before merging it. After the implementation merges, deliver the test-only changes separately to `develop` without user approval. Use a direct merge when protection allows it, or a test-only PR when protection requires one. Do not bypass protection. Keep production changes out of test-only delivery; return any required production fix to the reviewed implementation path.

Keep detailed reports, logs, screenshots, traces, and other task evidence in Task-linked artifacts, not PR files or project documentation. Complete all required deliveries and acceptance checks before removing the task worktrees and branches.

CI may run automatically on `develop`, but it is not a merge requirement. Do not trigger extra CI or wait for optional checks before merging an approved feature PR. If repository protection unexpectedly blocks the merge, report the blocker instead of bypassing it. Required promotion and release CI checks still apply.

During feature development, run only relevant unit tests, typecheck/lint, a targeted integration case, or a small live smoke check locally. Full integration suites and other broad, heavy test runs belong only in CI/CD. Do not run them locally, including through an umbrella check command. Keep live tool and TUI verification for changed behavior; it is an internal check, not a separate user acceptance gate.

# Tool capability checks

When changing an IDE tool or its supported composition with another tool, review and update the paid capability matrix and affected executable cases in `benchmarks/tool-capabilities/`. This is required even when the tool schema stays the same.

Run `pnpm check:capabilities` without inference. See `benchmarks/tool-capabilities/README.md` for the maintenance steps and paid runner. Paid runs are separate from ordinary tests and need explicit model/cost permission. Unrun routes stay unverified; keep failed attempts visible.
