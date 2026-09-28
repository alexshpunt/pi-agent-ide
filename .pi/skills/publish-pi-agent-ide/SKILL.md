---
name: publish-pi-agent-ide
description: Prepare, validate, publish, or recover a pi-agent-ide release from the public repository. Use for versions, release branches, npm publishing, and tags.
---

# Release Pi Agent IDE

Read `docs/releases.md` completely before changing release branches or workflows. Release only the root `pi-agent-ide` package. Do not run `npm publish` locally or publish a nightly artifact to npm.

Start on public `main` using the **Start release** workflow with finished notes. Keep `main` frozen while `release/X.Y.Z` exists; allow only reviewed release fixes. Rebase the release branch on main after fixes and revalidate. Merge only the verified release PR. Run **Publish to npm** first with `publish: false`, then request `publish: true` and obtain the manual npm environment approval. Check the exact verified archive and immutable tag. Wait for the develop synchronization job to pass before calling the release complete. The post-publication benchmark is separate evidence, not a reversible transaction.

If evidence is stale, credentials or approvals are missing, or the registry/package differs, stop rather than bypassing the workflow. Never commit credentials or publish a rebuilt archive.
