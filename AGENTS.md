# Feature PRs and checks

Finish features through a PR to `develop`, not a direct merge or push. Commit and push the changes, create the PR, and open its URL in the user's browser. Use the PR for user review instead of GIF demonstrations. Wait for explicit user approval of the current PR head before merging. If the head changes, ask for approval again. After merging, remove the feature worktree and branch.

Read `skills/review-pr/SKILL.md` when a PR is ready for review. Show the current head, start its background review listener before going idle, and handle feedback until the user approves that head or stops the task. GitHub approval must come from the user's established account; the agent's bot and other reviewers cannot approve on their behalf.

CI may run automatically on `develop`, but it is not a merge requirement. Do not trigger extra CI or wait for optional checks before merging an approved feature PR. If repository protection unexpectedly blocks the merge, report the blocker instead of bypassing it. Required promotion and release CI checks still apply.

During feature development, run only relevant unit tests, typecheck/lint, a targeted integration case, or a small live smoke check locally. Full integration suites and other broad, heavy test runs belong only in CI/CD. Do not run them locally, including through an umbrella check command. Keep live tool and TUI verification for changed behavior; it is an internal check, not a separate user acceptance gate.

# Tool capability checks

When changing an IDE tool or its supported composition with another tool, review and update the paid capability matrix and affected executable cases in `benchmarks/tool-capabilities/`. This is required even when the tool schema stays the same.

Run `pnpm check:capabilities` without inference. See `benchmarks/tool-capabilities/README.md` for the maintenance steps and paid runner. Paid runs are separate from ordinary tests and need explicit model/cost permission. Unrun routes stay unverified; keep failed attempts visible.
