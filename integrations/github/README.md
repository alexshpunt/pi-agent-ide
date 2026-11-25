<p align="center">
  <img src="assets/banner.png" alt="Pi Agent GitHub" width="100%">
</p>

<h1 align="center">Pi Agent GitHub</h1>

<p align="center">Give your Pi agent GitHub tools for issues, pull requests, discussions and the API, with a selected user or GitHub App identity.</p>

<div align="center">

[![npm version](https://img.shields.io/npm/v/pi-agent-github)](https://www.npmjs.com/package/pi-agent-github)
[![npm downloads](https://img.shields.io/npm/dm/pi-agent-github)](https://www.npmjs.com/package/pi-agent-github)
[![CI status](https://img.shields.io/github/actions/workflow/status/alexshpunt/pi-agent-ide/ci.yml?branch=develop&label=CI)](https://github.com/alexshpunt/pi-agent-ide/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

## Summary

Pi Agent GitHub lets the [Pi coding agent](https://pi.dev/) read, search and change GitHub through addressable resources. The agent can follow a PR to its diff, inspect a review thread, edit an issue body or send a REST request without switching identities or inventing a separate workflow for each object.

| Work                | What the agent can do                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Issues              | Find, read and create issues; edit bodies, labels, milestones and supported fields; write comments                                 |
| Pull requests       | Create PRs from existing branches; inspect diffs and checks; comment, reply, review and resolve threads; merge with the known head |
| Discussions         | Find categories and posts; create and edit discussions, comments and replies                                                       |
| CI context          | Read workflows, runs, jobs, steps, logs and artifact links                                                                         |
| Projects            | Read organization/user Projects, fields, items and saved views with their filters                                                  |
| Repository context  | Read files and trees at verified refs, commits and comparisons                                                                     |
| Releases and assets | Read and edit supported release resources; upload and read release assets without changing their bytes                             |
| Open API            | Read REST resources and send REST or GraphQL requests when a dedicated view does not cover the operation                           |

Access depends on the selected connection's permissions and repository access. A supported API route is not a promise that your credentials can use it.

### Automatic IDE and standalone modes

With [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide) enabled, GitHub plugs into its ordinary `read`, `search` and editing tools. It adds no duplicate GitHub tool family.

Without the IDE extension enabled, GitHub exposes deferred `github_*` tools. Find them through `tool_search`; use them directly or inside Codemode. The addresses, backend and bounded selections are shared between modes. Standalone tools handle GitHub resources and packaged guidance, not local files.

The guides use ordinary resource-tool names. In standalone mode, Read means `github_read`, Write means `github_write`, and other resource tools use the same `github_` prefix. Start with `github_read({path: "docs:github"})`.

Standalone mode uses Pi Agent IDE 1.1 or newer in the 1.x series as a library. It does not enable the IDE tools.

### Built for agents you trust with GitHub

Pi Agent GitHub is designed for YOLO-style work: let the agent use the GitHub API to carry out the task you gave it. The open REST/GraphQL interface is where it has the broadest reach.

In IDE mode, typed high-risk actions such as merging a PR or submitting a review use the IDE's approval policy. Without a configured or remembered grant, unavailable UI or a refused confirmation blocks the action. `/agent-ide-settings` exposes **GitHub YOLO** for skipping those confirmations.

Standalone mode is always YOLO, including typed high-risk actions and headless calls. It does not ask for per-action confirmation and ignores IDE YOLO settings. Only load it for agents you trust with the selected connection's access.

Raw REST/GraphQL writes have no per-request confirmation, including headless mutations and DELETE. They can bypass the typed confirmation routes. Turning GitHub YOLO off does not make the raw API read-only or turn this extension into a sandbox.

Token permissions, payload checks and known-head requirements still apply. The agent must still follow your intent. See [access and recovery](docs/github-access.md) before using it for destructive work.

### Follow structure instead of scraping pages

A GitHub card links to its body, fields, comments, schemas and actions. The agent follows the resource it needs and reads the rest only when it matters.

- Open native GitHub URLs, explicit `github://owner/repository` addresses or supported API URLs.
- Discover issues, PRs and discussions within an explicit repository.
- Search a selected body, comment, file or response without crawling its links.
- Edit the intended text through guarded selections and supported editors.
- Read an action's schema before sending its JSON payload.
- Follow exact pagination links; incomplete pages stay visibly incomplete.

This keeps large PR conversations and API responses out of the agent's context until it needs them. It also keeps the distinction between reading an object and reading every object linked from it.

### Use the API when a dedicated view is not enough

The agent can read an exact REST resource, follow its links, and search the selected response. Write accepts intentional REST requests and GraphQL queries or mutations through the same selected connection.

Responses become session-owned resources that the agent can inspect before deciding what to do next. Expired responses fail rather than silently replaying the original request. The [coverage catalog](docs/github-coverage.md) points to API families; it does not claim every GitHub browser page has a native mapping.

### Choose a connection and know what changed

Connect your own App through device login, your own App's bot through its key file, or a PAT. Native calls use the session's selected profile. They do not call `gh`, search other saved accounts or change identity after a failed request. Global and project defaults and session overrides let separate agents work under different profiles.

Mutation receipts name the affected resource so the agent can reread it. A failed request and an unknown remote effect are different outcomes: an unknown write might already have reached GitHub. The agent must inspect it before retrying, including when switching tools.

## Installation

The GitHub package is not published yet. To try it now, use a [checkout or packed candidate](docs/development.md).

After the package is published, install it in [Pi](https://pi.dev/) with Node.js 24 or newer:

```bash
pi install npm:pi-agent-github
```

Remove GitHub with `pi remove npm:pi-agent-github`. This leaves the IDE extension and saved GitHub connections alone.

To try it for one session without changing your settings:

```bash
pi -e npm:pi-agent-github
```

To use the shared IDE tools, also install and enable [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide):

```bash
pi install npm:pi-agent-ide
```

Pi packages run with your system permissions. This one can change repositories your selected connection can access. Review it before installing.

### Connect your GitHub account

Run `/github` after reloading Pi. Log in with **your own App's Client ID**, your App's installation bot through its external private-key file, or a PAT through hidden terminal input. No publisher App or hosted login service is involved.

Adding a connection saves it without switching accounts or setting a default. Select an account for this session or as the global default for new sessions. Other running sessions keep their selection. The account list marks the active and default connections. See [setup](docs/setup.md) for login and logout details.

Tokens stay in owner-only local files outside repositories. They are plaintext, not encrypted; App keys remain separate files. Saved connections also work in non-interactive Pi. Existing PiClanker settings can be imported without changing them. See [setup](docs/setup.md) for each login method, storage and troubleshooting.

## Start using it

Ask the agent to read `docs:github` and choose the guide for the job. For example:

> Find open bugs in this repository, read the relevant discussions, and draft a fix PR against the existing feature branch. Ask before merging.

In IDE mode, a read looks like this:

```js
const issue = await tools.read({
  path: "https://github.com/owner/repository/issues/17",
});
if (issue) text(issue.text);
```

In standalone mode, discover the GitHub tools and use `tools.github_read` for the same call. Read the returned body or action link separately rather than assuming the card includes it.

## Limits

- The selected credentials' repository access and permissions bound every operation. Authentication failures stop native access.
- Native object discovery is repository-scoped. Text search has no global content index or recursive crawl.
- Pre-save checks detect known conflicts; they are not atomic compare-and-swap.
- Text and friendly file views are bounded to 2 MiB; binary transport to 25 MiB.
- Release assets are the supported upload store. Browser issue/comment attachment uploads are not emulated through undocumented endpoints.
- Binary metadata is not archive, PDF or OCR extraction. Supported images and text have readable views; other formats expose original bytes.
- Local Git branches, commits and pushes remain normal Git work. No Git executor or browser automation is hidden behind the resource tools.

Pi Agent GitHub is experimental and under active development. Interfaces and behavior may change.

## Feedback and contributions

If something breaks or does not fit your workflow, [open an issue](https://github.com/alexshpunt/pi-agent-ide/issues) or start a [discussion](https://github.com/alexshpunt/pi-agent-ide/discussions). Bug reports, ideas, questions and pull requests are welcome.

Include the Pi/package versions, the kind of resource you used and a redacted error or reproduction. Do not post App keys, access/refresh tokens, private repository content or signed download URLs.

## Documentation

| Document                                            | Contents                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| [Setup](docs/setup.md)                              | Your own App/PAT connections, local storage and session profiles |
| [Capabilities and limits](docs/capabilities.md)     | Resource coverage and boundaries                                 |
| [Start here](docs/github.md)                        | Choosing a focused agent guide                                   |
| [Discovery](docs/github-discovery.md)               | Repository discovery and selected-resource search                |
| [Issues](docs/github-issues.md)                     | Bodies, metadata, comments, labels and milestones                |
| [Pull requests](docs/github-pulls.md)               | Diffs, review comments, threads, reviews and merge               |
| [Discussions](docs/github-discussions.md)           | Categories, posts, comments and replies                          |
| [Files and artifacts](docs/github-files.md)         | Repository files and byte-preserving release assets              |
| [Repository and CI context](docs/github-context.md) | Checks, workflows, Projects, trees, commits and links            |
| [Open API](docs/github-api.md)                      | REST/GraphQL requests and response resources                     |
| [Coverage catalog](docs/github-coverage.md)         | API-family entry points and access limits                        |
| [Access and recovery](docs/github-access.md)        | Selected identity, confirmations and uncertain effects           |
| [Development](docs/development.md)                  | Checkout setup and checks                                        |

## License

[MIT](./LICENSE)
