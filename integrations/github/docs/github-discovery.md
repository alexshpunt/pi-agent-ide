# GitHub discovery and text Search

Use `search({query:"github:issues terms",path:"github://owner/repository"})` or `github:pulls` / `github:discussions` for native API discovery. Supply an explicit repository. The query cannot override that scope with repo/org/user qualifiers. Returned links open with Read. Follow the exact continuation URL; incomplete pages and GitHub's search result ceiling never prove absence.

For literal or regex text Search, select one card, body, comment or file first. Ordinary queries search only that source. Shared Read/Search ranges stay bounded and stale snapshots fail. The provider does not crawl linked bodies or build a global index. Glob, AST and shell-style queries are not supported over these resources. Regex matching has a bounded worker timeout; timeout is an error, not zero matches.

Read an unfamiliar API resource at its displayed `https://api.github.com/` URL, or start from `github://api`. Follow its collection links instead of inventing discovery kinds. Use GitHub's documented search endpoint or GraphQL through [Open API](docs:github-api) for API-supported discovery outside issues/PRs/discussions. An API query can cover more than a repository only when you explicitly choose that scope. Text Search of its response remains local to the selected resource.
