---
name: take-task
description: Take a numbered Linear task through investigation, discussion, implementation, user acceptance, and a PR into develop. Use whenever the user gives a task number or identifier and asks to take it, start it, work on it, or implement it. Do not use for a request to only read or list issues.
---

# Take a task

## Read the task and move into its worktree

1. Read the Linear skills and use `linear_axi` to find the task by its number or identifier. Read its description, linked materials, and relevant comments. If a bare number matches more than one task, ask the user which one they mean.
2. Create a new branch and worktree from `develop` with Teleport. Include the task identifier (including its number) and a short task description in the name, for example `abc-123-fix-read-preview`.
3. Use Teleport to jump into that worktree. Continue all task work there. Set up temporary local IDE loading yourself using the section below. Do not assume the worktree already has the right settings or loader.
4. Update the task in Linear as work progresses. Use the team's existing statuses rather than inventing new ones. Keep useful decisions, blockers, progress, and links on the task.

## Temporarily load the worktree's IDE

The task session must run the worktree's code, not the globally installed IDE. Load exactly one copy: two copies cause duplicate plugin and post-edit handler registrations.

- Read the current Pi package docs and inspect personal and project settings. Find the global IDE package source and resolve its identity; relative paths resolve from the settings file, not the current directory.
- Record the existing contents and Git status of each file you will touch. Keep any backup in the ignored `.tmp` directory. Preserve unrelated settings and other agents' changes.
- In this worktree's `.pi/settings.json`, override the same global package source with `extensions: []`. Use a normal project package entry, not `autoload: false`. Do not edit personal settings. Preserve other resource filters and unrelated package entries.
- Create or temporarily enable one `.pi/extensions/pi-agent-ide.ts` loader that re-exports `../../src/pi-agent-ide.js`. Disable any other local IDE loader or package entry for this checkout so it does not load twice. Check that dependencies are available. No package installation is needed just to load the checkout.
- Treat these edits as session setup, not feature changes. Do not stage, commit, or push them, even if a file is already tracked. Use explicit staging paths rather than `git add .`.
- Before reloading, run the normal-configuration startup smoke test described in step 8. Then reload Pi and confirm that only this worktree's IDE loads. If loading fails, fix the setup before continuing.

After the feature passes local verification, remove your temporary loader and package override, or restore the previous contents if those files existed. Restore only your own edits; do not overwrite changes made by another agent. Confirm that no task-session setup remains in the diff or index. Run the startup smoke test again with the restored configuration, then reload Pi to return to normal global IDE loading before review and Git work. If the user asks for more changes, repeat the temporary setup and cleanup. Also clean up if the task is canceled or paused; report any blocker rather than leaving a broken loader behind.

## Investigate before implementing

5. Study the codebase and find what the task refers to. Read the relevant code, docs, and tests. Do not start implementing yet.
6. Tell the user what the task asks for and what you found in the code. Discuss whether the task is still needed and how to do it. Use `ask_user` for decisions and unresolved scope. Wait for agreement before implementing.

## Implement and open the PR

7. Implement the agreed task in its worktree. Keep Linear up to date if the scope changes or work becomes blocked.
8. Check the changed behavior with focused local checks: relevant unit tests, typecheck/lint, a targeted integration case, or a small live smoke check. Full integration suites and other broad, heavy test runs belong only in CI/CD; do not run them locally or through an umbrella check command. For tool or extension changes, read `pi-feature-verification` and follow this order:
   - Before reloading your working session, launch a separate Pi process from the current worktree with the normal project configuration. Use an in-memory session and no model prompt. Check that Pi starts, loads this worktree's extension without errors or duplicate registrations, and shuts down cleanly. Do not use `--no-extensions` or an explicit entrypoint: that would bypass the configuration you need to check. Inspect startup errors as well as the exit code. If the smoke test fails, fix it before reloading.
   - After the smoke test passes, call `pi_extension_dev_reload_self` with `confirm_state_loss: true`. Include the current worktree and exact verification steps in the continuation prompt. Reload may reset extension state; do not depend on it surviving.
   - Immediately after reload, exercise the changed tool or feature. Check the agent-facing output and, when it renders to the user, capture and inspect the real viewport with `inspect_tui`. Keep this as internal verification, not a separate GIF demonstration or acceptance gate.
9. Remove the temporary local IDE setup and return to normal loading as described above. Check that temporary settings and loaders are absent from the staged diff. Commit and push only the task changes. Create a PR targeting `develop`, link the Linear task, and summarize the changes, checks, and checks not run.
10. Read `../../../skills/review-pr/SKILL.md` and follow its review loop. Open the created PR in the user's browser, name the current head, and start the background review listener before going idle. Accept only the user's GitHub approval or explicit approval in this session for that shown head. Do not merge, remove the worktree, or mark the task done before approval.
11. Handle comments and requested changes, run focused checks, clean up temporary IDE setup, and update the same PR. Show the updated head and resume the listener. Keep the cursor so feedback received while you were working is not lost. Approval applies only to the reviewed head.

## Merge and finish

12. After explicit user approval, merge through the PR using the expected head SHA. CI may run automatically on `develop`, but it is not required for this merge. Do not trigger extra CI or wait for optional checks. If repository protection blocks the merge, report the blocker and keep the branch and worktree; do not bypass it. Required promotion and release CI checks are separate and still apply.
13. After the merge succeeds, return from the task worktree with Teleport and remove that worktree. Delete the task branch locally and remotely once it is safe to do so. Do not remove other agents' work or unrelated changes.
14. Move the Linear task to the appropriate completed status and attach the PR link. If the task was canceled instead, use the appropriate canceled status, not completed.
15. Tell the user the task is merged and cleaned up, then stop.
