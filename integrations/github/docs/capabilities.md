# Capabilities and limits

Use ordinary Read, Search and supported editors when Pi Agent IDE is enabled. Otherwise discover the deferred `github_*` resource tools through `tool_search`; the guide names map to their prefixed counterparts, such as `github_read` and `github_write`. Both modes use the same selected GitHub connection and support direct calls and Codemode. Start with `docs:github` and choose one focused guide. Linked bodies stay lazy; a card or collection does not include all linked text in its selection.

## Resource interface

| Resource                     | What you can do                                                                                                              | Guide                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| REST API                     | Read exact API URLs, follow links and scoped pagination, Search selected text, read original byte windows                    | `docs:github-api`                          |
| Open requests                | Send arbitrary REST methods and GraphQL queries/mutations through Write; Read/Search the returned response snapshot          | `docs:github-api`                          |
| Issues                       | Read/list/search/create; edit bodies and typed metadata; create/edit comments                                                | `docs:github-issues`                       |
| Pull requests                | Read/list/search/create; edit bodies/fields; conversation and inline comments/replies; reviews, threads and known-head merge | `docs:github-pulls`                        |
| Discussions                  | Categories, posts, comments/replies, scoped discovery and body/field edits                                                   | `docs:github-discussions`                  |
| PR and CI context            | Exact head checks/status; workflows, runs, jobs, steps, logs and artifact links                                              | `docs:github-context`                      |
| Projects                     | Organization/user cards, fields, items, saved views and their filtered items; cross-repository issue/PR links                | `docs:github-context`                      |
| Repository context           | Verified blob/tree refs, including slash-containing names; file lines, diff context, commits and comparisons                 | `docs:github-context`                      |
| Release assets               | Native uploads, original-byte reads and supported text/PNG/JPEG presentation; browser tag/download identity lookup           | `docs:github-files`                        |
| Labels, milestones, releases | Read/list/create and typed field edits                                                                                       | `docs:github-issues` and displayed schemas |

The searchable `docs:github-coverage` catalog maps API families to their entry points. Universal transport means a new endpoint does not need a dedicated adapter. It does not mean the installation can access every endpoint or that every browser page has a resource mapping.

## Access and safety

- The selected profile supplies the identity: user authorization through your own App, your App installation bot, or a PAT. Project defaults and session overrides stay separate. There is no account fallback or automatic permission expansion. Repository access and granted permissions bound every operation.
- IDE mode uses the shared approval policy for typed high-risk actions. Standalone is always YOLO, including typed actions without UI, and ignores IDE YOLO settings. See [access and recovery](github-access.md).
- Raw REST/GraphQL Write is ungated in both modes, including headless mutations and DELETE. It can bypass typed merge/review/release confirmations. Ask the user before destructive work.
- Native object discovery requires an explicit repository. Text Search stays within the chosen resource or selection; there is no global content index or recursive crawl.
- Requests are bounded and cancellable. Text and friendly file views are limited to 2 MiB; binary transport to 25 MiB. Response snapshots belong to the session and can expire or be evicted. Expiration never replays a request.
- Signed URL query credentials are redacted in ordinary presentation. Original-byte Read intentionally preserves them; do not copy raw output into public artifacts.
- Unknown mutations are never automatically replayed. Keep returned identities and reread the target before deciding whether to retry. Pre-save checks detect conflicts but are not atomic compare-and-swap.

## Presentation and routing limits

- Project view items apply the exact saved filter. Browser sorting/grouping are not reproduced; items use API connection order. Missing filters fail honestly rather than returning unfiltered parent items.
- Ambiguous browser ref/path splits, wrong-owner resources and unidentifiable fragments fail explicitly. Missing or truncated patches do not prove a complete diff.
- Numeric discussion comments and draft release aliases use verified identity lookup. Bounded lookups can report incomplete coverage.
- Binary metadata is not extraction. There is no OCR, archive expansion or PDF extraction; unsupported formats expose original bytes.
- Release assets are the supported artifact store. General browser issue/comment attachment uploads are not emulated with undocumented endpoints or another storage service.
- No dedicated workflow executor, repository administration UI or Git executor is added. Use Bash with an explicitly authorized identity for execution and complex operations, or send an intentional raw API request. Native profile selection does not change shell authentication.

See [setup](setup.md) for connection setup and [development](development.md) for contributor checks.
