---
name: take-task
description: Take a numbered Linear task through investigation, discussion, implementation, user acceptance, and a PR into develop. Use whenever the user gives a task number or identifier and asks to take it, start it, work on it, or implement it. Do not use for a request to only read or list issues.
---

# Take a task

## Read the task and move into its worktree

1. Read the Linear skills and use `linear_axi` to find the task by its number or identifier. Read its description, linked materials, and relevant comments. If a bare number matches more than one task, ask the user which one they mean.
2. Create a new branch and worktree from `develop` with Teleport. Include the task identifier (including its number) and a short task description in the name, for example `abc-123-fix-read-preview`.
3. Use Teleport to jump into that worktree. Continue all task work there. The tracked `.pi/settings.json` loads `packages: [".."]`, so Pi reads this worktree's package manifest and source directly. Do not install, publish, or add an absolute extension path for local development. Check that dependencies are available and that only this worktree's IDE extension loads; a global package pointing at another checkout can load a second copy.
4. Update the task in Linear as work progresses. Use the team's existing statuses rather than inventing new ones. Keep useful decisions, blockers, progress, and links on the task.

## Investigate before implementing

5. Study the codebase and find what the task refers to. Read the relevant code, docs, and tests. Do not start implementing yet.
6. Tell the user what the task asks for and what you found in the code. Discuss whether the task is still needed and how to do it. Use `ask_user` for decisions and unresolved scope. Wait for agreement before implementing.

## Implement and ask for acceptance

7. Implement the agreed task in its worktree. Keep Linear up to date if the scope changes or work becomes blocked.
8. Check that the result works. Run relevant checks and demonstrate the behavior. A full CI/CD run is not required, but do not skip checks needed to verify this task or checks required by the repository. For tool or extension changes, read `pi-feature-verification` and follow this order:
   - Before reloading your working session, launch a separate Pi process from the current worktree with the normal project configuration. Use an in-memory session and no model prompt. Check that Pi starts, loads this worktree's extension without errors or duplicate registrations, and shuts down cleanly. Do not use `--no-extensions` or an explicit entrypoint: that would bypass the configuration you need to check. Inspect startup errors as well as the exit code. If the smoke test fails, fix it before reloading.
   - After the smoke test passes, call `pi_extension_dev_reload_self` with `confirm_state_loss: true`. Include the current worktree and exact demonstration steps in the continuation prompt. Reload may reset extension state; do not depend on it surviving.
   - Immediately after reload, exercise the changed tool or feature and demonstrate the result. Check the agent-facing output and, when it renders to the user, capture and inspect the real viewport with `inspect_tui`. Report what you observed, not just that tests passed.
9. Tell the user the task is ready for their review. Show what changed, what you checked, and how they can verify it. Ask with `ask_user` whether they are satisfied or want changes.
10. Wait for explicit acceptance, such as “OK”. If the user wants changes, make them, check them, and ask again. Do not create or merge the PR, remove the worktree, or mark the task done before acceptance.

## Merge and finish

11. After acceptance, commit and push the task branch. Create a PR targeting `develop` so the work is visible. Link the Linear task and summarize the changes and checks.
12. Merge through the PR. Respect required repository checks; a full optional CI/CD run is not necessary. If merging is blocked, report the blocker and keep the branch and worktree.
13. After the merge succeeds, return from the task worktree with Teleport and remove that worktree. Delete the task branch locally and remotely once it is safe to do so. Do not remove other agents' work or unrelated changes.
14. Move the Linear task to the appropriate completed status and attach the PR link. If the task was canceled instead, use the appropriate canceled status, not completed.
15. Tell the user the task is merged and cleaned up, then stop.
