# GitHub resource coverage index

Use Read for API resources, Search for selected text, editors for the displayed writable resources, and Write for arbitrary REST/GraphQL. Use Bash with the App for Git execution and complex actions when that is simpler. This is not a command-by-command CLI replacement.

## Choose the smallest guide

| Resource                                               | Guide                                  |
| ------------------------------------------------------ | -------------------------------------- |
| Issues, labels, milestones, ordinary comments          | [Issues](docs:github-issues)           |
| PR context, diffs, reviews and threads                 | [Pull requests](docs:github-pulls)     |
| Discussions, categories and replies                    | [Discussions](docs:github-discussions) |
| CI, Projects, trees, commits and browser links         | [Context](docs:github-context)         |
| Files, release assets and original bytes               | [Files](docs:github-files)             |
| Any other reachable REST resource or GraphQL operation | [Open API](docs:github-api)            |
| Permission, bounds or unknown effects                  | [Access](docs:github-access)           |

## Universal API families

GitHub's [installation-token endpoint catalog](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) describes token compatibility. It does not grant this installation extra permissions. Use an endpoint's own documented route rather than guessing from a family name.

These REST families can use the universal API interface; useful dedicated views are separate from universal transport support:

| Families                                                                  | What to look for                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| actions, checks                                                           | Workflows, runs, jobs, steps, logs, artifacts, check suites/runs, cache and runner metadata                     |
| branches, commits, git, repos                                             | Branches, refs, objects, trees, repository contents, comparisons and repository metadata                        |
| issues, pulls, reactions                                                  | Issues, PRs, comments, reviews, relationships, timelines and reactions                                          |
| projects                                                                  | Projects, views, fields and linked items under accessible owners                                                |
| releases, packages                                                        | Releases, assets, packages and versions                                                                         |
| deployments, pages                                                        | Environments, deployment/status resources and Pages metadata                                                    |
| orgs, teams, users, collaborators, interactions                           | Organization, team, user and access-related metadata where the installation is authorized                       |
| code-scanning, code-security, secret-scanning, security-advisories        | Security alerts, configuration and advisory metadata                                                            |
| dependabot, dependency-graph, campaigns, code-quality                     | Dependency alerts/graphs, campaigns and quality information                                                     |
| codespaces, copilot, copilot-spaces, agents                               | Only endpoints compatible with this installation token; user-owned features can require different authorization |
| activity, metrics                                                         | Events, subscriptions/activity endpoints, statistics and traffic where permitted                                |
| apps, billing, deploy-keys, private-registries                            | Readable installation/account/admin metadata where permitted; no new administration interface                   |
| codes-of-conduct, emojis, gitignore, licenses, markdown, meta, rate-limit | Public/reference data, rendering APIs, service metadata and rate limits                                         |

GraphQL has no single REST-style endpoint list. Send a query through the [Open API](docs:github-api) entry point, then Read/Search its response resource. Discussions and some Project relationships also have dedicated views.

## What coverage does not mean

- A supported request format does not prove permission to its target. Report 403, inaccessible resources and unsupported token types honestly.
- User authorization is not added. Some Gist and personal Codespaces operations need a user token; the provider never silently switches accounts.
- A universal JSON resource is not a custom card for every API type. Use its fields, verified links and pagination to navigate it.
- Browser routing covers identifiable resource URLs, not every settings/login page or UI button. Read the exact API resource when a browser page has no native mapping.
- Original binary bytes are available within transport bounds; PDF/archive extraction, OCR and global content crawling are not implied.
- Recorded API fixtures, actual live reads and permission-denial observations are different evidence. See the repository's capabilities and verification reports for tested behavior; do not call every endpoint live-tested.
