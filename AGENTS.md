# Feature PRs and checks

Deliver each feature to `develop`. Keep separate project documentation and unrelated test changes out of the implementation PR. When the implementation removes or changes behavior that existing tests rely on, update those tests in the same PR so it stays green. Explain the problem and the chosen solution in the PR description and link the Task.

Keep detailed reports, logs, screenshots, traces, and other task evidence in Task-linked artifacts, not PR files or project documentation. Complete all required deliveries and acceptance checks before removing the task worktrees and branches.
Never commit task evidence or run artifacts to Git, including summaries, reports, logs, screenshots, and traces. When retention is required, attach them to the corresponding Task; disposable local copies belong in ignored temporary directories. Reusable test fixtures and executable benchmarks are not run artifacts.

CI may run automatically on `develop`, but it is not a merge requirement. Do not trigger extra CI or wait for optional checks before merging a feature PR. If repository protection unexpectedly blocks the merge, report the blocker instead of bypassing it. Required promotion and release CI checks still apply.

During feature development, run only relevant unit tests, typecheck/lint, a targeted integration case, or a small live smoke check locally. Full integration suites and other broad, heavy test runs belong only in CI/CD. Do not run them locally, including through an umbrella check command. Keep live tool and TUI verification for changed behavior; it is an internal check, not a separate user acceptance gate.

Do not test prose: tool descriptions, prompts, skills, documentation, or human-readable log, UI, and error wording. Delete any test found to pin that wording immediately; do not weaken its assertion or leave it for later. Machine-parsed protocol and file-format contracts are exempt.

Run one integration file with `npx pi-test run -- vitest run --config vitest.integration.config.mjs <file>`. `pnpm test:integration -- <file>` does not filter: it runs the whole integration suite.

In scripted-provider tests that embed Codemode scripts, use distinct reference-placeholder namespaces for the outer provider and the nested script. The provider also substitutes inside script strings; nested placeholders must survive until their issuing calls run. See `tests/integration/json-structured-arguments.integration.test.ts` for `$issued-uuid:` and `$script-uuid:`.

When asserting a Codemode return value, check the exposed script value or an existing case for that tool first. Script values can differ from native tool execution details: `lsp_search` exposes `matches[].line`, while native hits use `lineNumber`.

To find a slow code path, profile a focused vitest file: `npx vitest run <file> --pool=forks --execArgv=--cpu-prof --execArgv=--cpu-prof-dir=<dir>` writes one `.cpuprofile` per test worker. Keep the profile directory outside the repository or in `.tmp/`.

Before testing native Rust diagnostics against a large workspace, account for rustup/toolchain executable discovery: it can bypass a Cargo interceptor placed only in `PATH`. Set `CARGO` to the interceptor and add an independent `RUSTC_WRAPPER` that records and blocks compilation while allowing toolchain probes. Verify the guards on a small fixture before using a large workspace; see `tests/integration/rust-diagnostics-no-build.integration.test.ts`.

# Tool capability checks

When changing an IDE tool or its supported composition with another tool, review and update the paid capability matrix and affected executable cases in `benchmarks/tool-capabilities/`. This is required even when the tool schema stays the same.

Run `pnpm check:capabilities` without inference. See `benchmarks/tool-capabilities/README.md` for the maintenance steps and paid runner. Paid runs are separate from ordinary tests and need explicit model/cost permission. Unrun routes stay unverified; keep failed attempts visible.
