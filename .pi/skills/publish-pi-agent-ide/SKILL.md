---
name: publish-pi-agent-ide
description: Prepare, validate, publish, or recover a pi-agent-ide release from the public repository. Use whenever a user asks to release, publish, version, promote, or finish pi-agent-ide, including release branches, npm publishing, and tags. Pin the release scope while develop stays open.
---

# Release Pi Agent IDE

Release only the root `pi-agent-ide` package through GitHub Actions. Never run `npm publish` locally or publish a nightly artifact. Read `docs/releases.md` and the relevant release workflows before running them. This skill defines agent behavior; workflows and scripts define the executable checks. If they disagree, resolve the difference before proceeding.

## Pin the release scope first

`develop` stays open throughout the release. Never ask other agents to stop merging features just to keep release CI stable.

1. Identify the approved source commit and record its full SHA. “Current develop” means the commit selected now, not every later commit that reaches develop.
2. If release preparation needs changes, use a separate worktree and a PR to develop. Wait for its CI and merge it. Record the resulting develop commit as the release cut.
3. If the cut is not yet on main, create a separate promotion branch from that exact commit, such as `chore/promote-X.Y.Z`. Open its PR to main. Do not use the moving `develop` branch as the promotion PR head.
4. Leave the promotion branch pinned while its CI runs. New develop merges belong to later work unless the user explicitly changes this release's scope. Do not merge or rebase newer develop commits into the promotion branch by default.
5. Merge the verified promotion PR using its expected head SHA. Check that **Synchronize main into develop** succeeds before starting the versioned release.

A promotion branch pins the approved source before the versioned release exists. `release/X.Y.Z` pins the candidate after Start release. These are separate stages; neither requires freezing develop. A new PR still needs its own required checks: passing CI on another PR or the same source tree does not bypass branch protection.

If a promotion PR already uses develop and new feature merges change its head, stop following the moving head. Create a pinned promotion branch from the recorded cut and replace the moving-head PR. Keep develop open. If no cut was recorded and the intended scope is unclear, ask the user which commit to release.

## Refresh after a failed release check

For this project, a failed CI/CD check before publication is a gate to review the release scope again. Keep the unused version number; do not skip it just because a candidate failed. A watcher timeout is not a CI failure: check the actual run first.

1. Record the failed job and diagnose its logs or artifacts. Fix and verify the cause before starting another candidate. Do not assume newer develop commits fixed it.
   Download the immediate unit report before canceling a running job. Unit failures stop Validate before integration starts, so let report upload and normal shutdown finish. Forced cancellation can discard job logs; do not use it before retaining the failure evidence.
2. Fetch develop and inspect changes since the recorded cut. Compare the actual trees as well as commit history, because squash promotion can make old commits appear new.
3. If a versioned candidate is active, cancel it through the workflow before promoting a refreshed scope. Check that cancellation and main-to-develop synchronization succeed. Preserve any reviewed release fixes already on main.
4. Put remaining fixes into develop through a verified PR. Include workflow or fixture fixes when those caused the failure; do not weaken product contracts to make a test pass.
5. After the fixes merge, capture the latest develop SHA as a new cut. Update the notes for all included changes. Promote through a new pinned branch, then run Start release again with the same unused version and updated notes.
6. Record fresh PR, base, head, run, and archive evidence. The previous candidate's evidence cannot be reused.

This is an explicit scope refresh after a failure, not permission to follow a moving develop head while CI runs. Keep each attempt pinned. If develop has no new changes, still carry the verified fix into the new cut; do not invent changelog entries or repeatedly rebuild an unchanged failing candidate. Never refresh a published version in place. Publication or a tag changes the recovery path and needs a new version decision.

## Start the versioned release

1. Check that the version is unused in npm and that no active `release/X.Y.Z` branch exists. Only exact stable version branches mark an active release; do not delete older `release/v*` or `release/official-*` branches.
2. Finish notes for the pinned scope, including preparation fixes. Do not include later develop features. Do not add the version or its CHANGELOG section manually: Start release owns both.
3. Run **Start release** (`release-start.yml`) on main with `version` and `notes`.
4. Record the created `release/X.Y.Z` branch, PR, head SHA, main base, and candidate CI run.

While `release/X.Y.Z` exists, main is frozen for features. Develop is not frozen. Only reviewed release fixes may change main. Do not create another develop-to-main promotion during the freeze.

## Validate and fix the candidate

Wait for the release PR's full required CI matrix. Candidate validation builds twice, compares archive bytes, scans and installs the archive, and tests the installed runtime. Do not treat source checks alone as candidate validation.

Inspect failures and their artifacts before changing code or rerunning checks. Do not disable tests, increase limits, or bypass required checks to finish a release. A retry may confirm an identified intermittent failure; it is not a substitute for fixing a repeated failure.

If the user explicitly keeps the pinned scope instead of refreshing it, fix a release defect through a reviewed `fix/release-*` PR to main labeled `release-fix`. Review the change itself, not just its label. Rebase the release branch onto the fixed main using `--force-with-lease`, then rerun candidate validation. A changed base, head, or archive requires fresh evidence. Never pull unrelated develop features into the release to repair it.

Squash-merge only the verified release PR with the expected head. Keep the release branch until publication and develop synchronization finish.

## Verify, publish, and finish

1. Run **Publish to npm** (`release.yml`) on main with the merged release PR number and its successful candidate CI run ID. First set `publish: false`.
2. After verification succeeds, use the same PR and candidate run with `publish: true`. Obtain manual approval for the protected npm environment after examining that exact archive.
3. The workflow downloads the tested archive; it does not rebuild it. Never substitute a locally built archive or another run's artifact.
4. Verify the registry version, archive integrity, and immutable tag.
5. Wait for **Synchronize develop and lift release freeze** to succeed. It verifies registry integrity, merges main into develop, and deletes the unchanged release branch with a lease.
6. Clean up the release worktree and its preparation branches after their work is merged. Report the published version and verification results.

Do not call the release complete before registry verification and synchronization succeed. The post-publication benchmark is separate evidence; its failure does not undo publication.

If develop advances during synchronization or a merge conflicts, keep the release branch and retry the same verified release after resolving the sync. Do not force-push develop or publish again with different bytes.

## Stop and recovery conditions

If credentials, approvals, or valid candidate evidence are missing, report the exact blocker. Never bypass the workflow, commit credentials, replace a tag, or publish a rebuilt archive.

Cancel only an unpublished release through **Cancel release** on main with its version and confirmation `cancel`. If its PR was already merged, first revert its product and version changes through normal review. A published or tagged release cannot be canceled.

## Check the behavior before handing off

- New features land in develop during promotion CI: the promotion head and release scope stay unchanged.
- New features land in develop during candidate CI: the release head, candidate archive, and CI evidence stay unchanged.
- A release fix changes main: the release branch is rebased and fresh candidate evidence is required.
- Develop advances during the final sync: repair or retry synchronization without replacing published bytes or freezing develop.
- A real release check fails and develop has new fixes: diagnose and verify the cause, cancel the old candidate, capture a new cut, update notes, and keep the unused version.
- The watcher loses its network connection while CI is healthy: restore observation without refreshing scope or claiming CI failed.