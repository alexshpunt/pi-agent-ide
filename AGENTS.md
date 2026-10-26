# Feature PRs and checks

Deliver each feature to `develop`. Keep separate project documentation and unrelated test changes out of the implementation PR. When the implementation removes or changes behavior that existing tests rely on, update those tests in the same PR so it stays green. Explain the problem and the chosen solution in the PR description and link the Task.

Keep detailed reports, logs, screenshots, traces, and other task evidence in Task-linked artifacts, not PR files or project documentation. Complete all required deliveries and acceptance checks before removing the task worktrees and branches.
Never commit task evidence or run artifacts to Git, including summaries, reports, logs, screenshots, and traces. When retention is required, attach them to the corresponding Task; disposable local copies belong in ignored temporary directories. Reusable test fixtures and executable benchmarks are not run artifacts.

CI may run automatically on `develop`, but it is not a merge requirement. Do not trigger extra CI or wait for optional checks before merging a feature PR. If repository protection unexpectedly blocks the merge, report the blocker instead of bypassing it. Required promotion and release CI checks still apply.

During feature development, run only relevant unit tests, typecheck/lint, a targeted integration case, or a small live smoke check locally. Full integration suites and other broad, heavy test runs belong only in CI/CD. Do not run them locally, including through an umbrella check command. Keep live tool and TUI verification for changed behavior; it is an internal check, not a separate user acceptance gate.

# Tool capability checks

When changing an IDE tool or its supported composition with another tool, review and update the paid capability matrix and affected executable cases in `benchmarks/tool-capabilities/`. This is required even when the tool schema stays the same.

Run `pnpm check:capabilities` without inference. See `benchmarks/tool-capabilities/README.md` for the maintenance steps and paid runner. Paid runs are separate from ordinary tests and need explicit model/cost permission. Unrun routes stay unverified; keep failed attempts visible.
