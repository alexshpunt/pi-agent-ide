# Read GitHub working context

Use linked context views for navigation. Reading a workflow or a Project never runs an action or changes its fields.

## PR and CI context

Read a PR's displayed checks/status context. Follow its check, workflow run, job, log and artifact links. Use a run's jobs and step metadata to locate a failure instead of reading every log in the repository. Read artifact metadata before its original-byte resource. Treat missing or expired logs/artifacts separately from an empty result.

Use ordinary Read for native Actions run/job URLs or displayed API resources. App access to PRs does not prove Actions/checks permission. Report denial; do not change scopes automatically. Use Bash with the App for dispatch, cancel, rerun or other execution operations, or send an intentional raw request through [Open API](docs:github-api).

## Projects

Start from a numbered organization/user Project link or displayed Project API resource. Follow fields, views and items separately. Follow an item's issue/PR link to read its body; the Project card does not include every linked issue's text.

Project cards link to Views. A view card shows its saved filter and bounded visible fields. Its Items link applies that exact filter, checks that the view did not change during the lookup, and preserves cursor pagination. A missing filter is a limitation, not permission to return all parent items. Browser sorting and grouping are not reproduced; results use API connection order. Saved views can change between pages, so reread the view before combining snapshots.

Project access follows its owner and the current installation permissions, not the working repository alone. User-only authorization is not added. Use raw API or Bash for complex Project changes; no new execution tool is required.

## Files, trees, commits and comparisons

Read a native blob/tree URL or an explicit file resource. Browser refs can contain slashes: use verified ref/path evidence, and do not guess the first URL segment. Follow the returned exact ref or SHA links to preserve revision context. Read commits/comparisons as resources; use Bash for checkout, rebase, cherry-pick and other Git execution.

For a file line or diff fragment, read the verified source context. A missing child or ambiguous fragment must not silently become a successful parent-card read. A missing/truncated patch is not proof of a complete diff.

## Release and discussion links

Open release-tag or release-download links to resolve actual release/asset identities. Keep draft releases unpublished; their browser names can differ from the requested tag. Use the returned asset resource for original bytes.

For a numeric discussion comment fragment, use the verified comment mapping in that exact discussion. A bounded lookup can be incomplete. Report that limit rather than guessing a GraphQL node ID or returning the post as if it were the comment.

Next: [Discovery](docs:github-discovery), [Files](docs:github-files), [Open API](docs:github-api), [Access](docs:github-access).
