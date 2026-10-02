# Develop and release Pi Agent IDE

The public `pi-agent-ide` repository owns development and releases. Feature branches merge into `develop`. Ready changes merge into `main`. A versioned release starts from `main` and freezes it until the package is published and `main` has been merged back into `develop`, or the unpublished release is explicitly canceled. `develop` stays open throughout.

## Activate the single repository

Create public `develop` from public `main` before opening a feature PR. Merge the migration feature into `develop` after CI passes, then merge `develop` into `main` through a second reviewed PR. Do not merge or push `pi-agent-ide-dev` history: the migration branch must be based on public `main`, and only reviewed files belong in the PR. Confirm that `develop` passes CI, the nightly workflow runs against it, and main branch protection and release App permissions work on the public repository. Keep npm publishing manual. Archive the private product repository only after these checks; do not delete it as part of the migration.

## Keep develop current

Squash-merging `develop` into `main` makes their histories diverge. The **Synchronize main into develop** workflow merges `main` back into `develop` after every ordinary `main` push; it does not force-push. If a versioned release is active, it waits: the publish or cancel workflow synchronizes `develop` before lifting the freeze. Check the sync job after every main merge. If an ordinary sync fails because develop advances during its push or a merge conflicts, resolve the conflict and rerun the sync workflow manually on `main`. During a release, repair the conflict and retry Publish or Cancel instead; the versioned branch keeps the freeze until synchronization succeeds. Never start another develop-to-main PR before the synchronization succeeds.

## Nightly

See [Develop nightly](nightly.md). Nightlies test a pinned `develop` commit and keep an installable package and test reports in GitHub Actions for 30 days. They do not publish to npm.

## Start a release

Choose a release cut by its full commit SHA. If that commit is not yet on main, promote it through a separate pinned branch such as `chore/promote-X.Y.Z`, not a PR whose head is the moving `develop` branch. Keep that promotion head unchanged while CI runs. New develop merges do not join the release unless its scope is explicitly changed. After promotion and main-to-develop synchronization succeed, start the versioned release below. See `.pi/skills/publish-pi-agent-ide/SKILL.md` for the agent runbook.

Run **Start release** on `main` with an unused `X.Y.Z` and finished release notes. The workflow checks that no other release branch or registry version exists, creates `release/X.Y.Z` with the version and changelog update, and opens a PR to `main`. The App needs Contents and Pull requests write access to this public repository. Configure `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` as Actions secrets; never commit the key. A release branch is the freeze marker. The `Validate` check is required on PRs to `main`; it rejects `develop` while a release branch exists. It admits only the matching release PR or a `fix/release-*` PR labeled `release-fix`. Review the fix itself: a label is not proof that a change is a fix.
Only a branch named exactly `release/X.Y.Z` is an active release marker; older `release/v*` and `release/official-*` branches remain untouched and do not block a new release.

During the freeze, fix defects in `main` through a labeled fix PR. Rebase `release/X.Y.Z` onto the updated `main` using `--force-with-lease` and wait for the release PR's new CI run. A changed base, head or archive requires fresh candidate evidence. Do not merge features into `main` while a release is active.

The release PR runs the full CI matrix. Its candidate step builds twice, compares archive bytes, scans and installs the package and tests the installed runtime. Do not merge a failed candidate. Squash-merge the verified PR into `main`; the protected `Validate` check must pass for the current head and base. Keep the release branch until publication and develop synchronization are complete.

## Verify, publish, finish

Run **Publish to npm** on `main` with the merged release PR number and its successful CI run ID. Leave `publish: false` to verify the PR, tree and artifact without publishing. For publication set it to `true` and approve the protected `npm` environment after examining that same verified archive. The workflow downloads the CI archive; it does not rebuild it. npm Trusted Publishing publishes only its exact bytes. A retry cannot replace a tag or overwrite an existing version with different bytes. Do not approve a stale or expired candidate: rerun validation instead.

After npm publication, **Synchronize develop and lift release freeze** checks the registry integrity, merges `main` into `develop`, pushes that merge, and deletes the unchanged release branch with a lease. If the merge conflicts or develop advances during the push, the branch stays in place and `main` remains frozen; resolve the conflict and retry the same verified release. The benchmark runs separately after npm publication; its failure is reported but does not undo publication. `PI_AUTH_JSON` and `HF_TOKEN` stay in Actions secrets for that benchmark.

To abandon an **unpublished** release, run **Cancel release** on `main` with its version and confirmation `cancel`. This closes its PR and deletes only the matching release branch if no registry version or tag exists. If the release PR was already merged, revert it on `main` through normal review, verify that its product and version changes are gone, then cancel. A package already published or tagged cannot be canceled.

## Protection and limits

Protect `main` against direct pushes and require the `Validate` check on PRs. The release-freeze check runs inside that required check; GitHub administrators who can bypass branch protection can also bypass the freeze. Review branch-protection permissions before relying on the freeze as a hard guarantee. GitHub's scheduler can delay nightly runs beyond the Berlin midnight hour; use manual dispatch to retry a skipped night. Verify the workflow on public branches before calling the migration complete. The existing public Git history and published tags are never rewritten or replaced. No old private repository code or history is needed for normal publication.
