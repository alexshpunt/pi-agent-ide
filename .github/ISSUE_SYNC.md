# GitHub issues to Linear

New issues in `alexshpunt/pi-agent-ide` create issues in Linear's LPT team and
`pi-agent-ide` project. The title and Markdown body are copied. The description
also includes the GitHub URL, repository ID, and issue ID. Empty bodies work.
Linear chooses the team's default backlog or triage state.

## Setup

Save a Linear personal API key as the repository Actions secret `LINEAR_API_KEY`.
It needs read access and permission to create issues in LPT and its `pi-agent-ide`
project. Do not put the key in the repository or workflow file.

The workflow and script must be on `main`, the repository's default branch.
Merging them into `develop` does not turn on the issue trigger.

## Reruns and failures

The script derives a stable Linear UUID from the immutable GitHub repository and
issue IDs. Linear only accepts client IDs in UUID v4 format, so the fixed source
hash uses that format. The script looks up that UUID, including archived issues,
before creating an issue. If creation loses its response or overlaps another run,
it checks the same UUID again. It never generates a new UUID on retry or overwrites an existing issue.
Do not change the UUID namespace or source-ID format: that would break this link.

API errors and missing authentication fail the Actions job. The job log and
summary show the created or reused Linear issue's identifier and URL. To recover
from a failure, fix the secret or API problem, then rerun the failed workflow.

This only imports newly opened issues. It does not import old issues or sync
later edits, comments, labels, or status changes.

## Check it live

1. Open a clearly marked test GitHub issue with a title and Markdown body.
2. Check the **GitHub issues to Linear** run in Actions. Its log and summary should
   identify the created Linear issue.
3. Check that Linear contains the original title and body, source URL, and IDs
   in the right team and project.
4. Rerun that Actions run. It should report the same issue as reused, without
   creating another issue.
5. Repeat with an empty body. Close the GitHub test issues and cancel the Linear
   test issues after the checks.

Local contract tests: `pnpm exec vitest run scripts/github-issue-to-linear.test.ts`.
