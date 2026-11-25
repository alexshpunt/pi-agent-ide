# GitHub: choose a guide

With Pi Agent IDE enabled, use ordinary resource tools. Without it, discover `github_*` tools through `tool_search`. Both modes work directly and in Codemode. Tool names in these guides map to the `github_` prefix in standalone mode: Read is `github_read`, Write is `github_write`, and so on. Read packaged `docs:github-*` guides through the selected Read tool.

In IDE Codemode, a successful GitHub action Write returns `{ source }`, the address of the resulting resource or saved API response. Read that source before making another change.

Standalone is always YOLO, including typed actions without UI; IDE YOLO settings are ignored. IDE mode retains its shared approval policy. Token permissions, exact scopes, stale-target checks and unknown-effect recovery apply in both modes. Read [Access](docs:github-access) before changing resources.

Native calls use the explicitly selected user or App connection. Check it with `/github status`; use `/github` to manage your own App/PAT profiles. Profile selection does not change Bash authentication. Read [Access](docs:github-access) before changing identity, using a Bash fallback or recovering from a failed request.

- [Discovery](docs:github-discovery): scoped object discovery and selected text.
- [Issues](docs:github-issues): issues, metadata and ordinary comments.
- [Pull requests](docs:github-pulls): PRs, review comments, threads and reviews.
- [Discussions](docs:github-discussions): discussion posts and replies.
- [Files](docs:github-files): repository files and release assets.
- [Context](docs:github-context): CI, Projects, trees, commits and browser links.
- [Open API](docs:github-api): universal Read and arbitrary REST/GraphQL Write, in YOLO mode.
- [Coverage](docs:github-coverage): searchable resource-family index and access limits.
- [Access](docs:github-access): auth, permission failures and unknown effects.

Start with a native GitHub URL or an explicit github://owner/repository scope. Read the displayed body, field, schema, action and continuation links. Cards and collection listings do not make all linked text part of a selection. Full capability is not blanket approval for merge, deletion, publication or review submission.
