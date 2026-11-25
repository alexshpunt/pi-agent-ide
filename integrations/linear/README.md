# Pi Agent Linear

Pi Agent Linear connects the [Pi coding agent](https://pi.dev/) to Linear. With [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide) loaded, Linear resources work through its ordinary Read, Search and editing tools. Without the IDE extension loaded, the package exposes dedicated `linear_*` tools. Both modes use the same AXI backend and authorization checks.

## What it does

| Work                    | Supported operations                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Issues and child issues | Read and create issues; change typed fields, labels, relationships and body text                                      |
| Projects and documents  | Read and create projects/documents; edit separate bodies and fields; rename documents and attach references           |
| Customer Requests       | Keep project-linked feedback separate from Tasks; link a request to an issue for Triage                               |
| Discussions             | Read paginated discussions; create, edit and delete supported comments                                                |
| Files and attachments   | Upload private files, add references, read selected assets and replace one verified attachment                        |
| Organization            | Discover teams, users, labels, statuses, cycles, milestones, views and templates; change supported writable resources |
| Releases and activity   | Work with releases, notes and status updates; read pipelines, notifications and backend guidance                      |
| Reviews                 | Inspect supported diffs and threads; comment, resolve threads, submit reviews and request guarded merges              |
| Workflow                | Use packaged intake/execution skills; manage native shared Agent Skills and existing template content                 |

Availability depends on the selected resource, Linear permissions and the backend's live schema. A listed resource is not necessarily writable. The tools return separate card, body, field, action and attachment links so the agent can choose the part it needs.

Object discovery uses the supported API search or directory operation. Text search stays inside the selected resource. Linked documents and comments are read separately; the package does not crawl your workspace.

<a id="setup"></a>

## Installation

Requires Node.js 24 or newer, Pi, and the `pi-agent-ide` SDK dependency. Installing that SDK does not require enabling the IDE extension.

Use the [installation guide](docs/installation.md) to enable Linear from the IDE checkout or install a supplied tarball. The package is not published to npm.

After enabling the package, reload Pi and run:

```text
/linear
```

Choose **Log in** to save a named connection, or **Select account** to choose a saved connection for this session or the default for new sessions. You can add another connection without logging out. Saved connections are shared locally; each Pi session keeps its own selection across reload and resume.

Browser sign-in opens your ordinary browser and displays a manual link. **Log out** lets you choose a connection to forget for every session that uses it, and attempts to revoke supported OAuth grants. The result explains when remote revocation is unavailable or uncertain.

Each supported path uses the selected credential. Status shows its actual capability limits; an unavailable native/file path never falls back to another app. See [installation and authentication](docs/installation.md) for setup and [access and recovery](docs/linear-access.md) for refusals and unknown outcomes.

## Use it with the IDE

Start with the short entry guide, then read the linked domain guide needed for the work:

```js
await tools.read({ path: "docs:linear" });
await tools.read({ path: "docs:linear-issues" });
```

For a verified issue URL, the agent can read a field and update it without replacing the description:

```js
await tools.read({ path: issueUrl + "#status" });
await tools.write({ path: issueUrl + "#status", content: statusValue });
```

Use the field's returned contract and a status from the issue's team. Body edits use the displayed `/description` or `/content` link, never the metadata-bearing card.

## Use it without the IDE extension

Ask the agent to find the standalone Linear tools. Pi's `tool_search` discovers the deferred `linear_read`, `linear_search`, `linear_write`, `linear_replace`, `linear_insert`, `linear_delete`, `linear_copy` and `linear_move` tools. `linear_upload` and `/linear` remain available in both modes.

```js
await tools.linear_read({ path: "docs:linear" });
await tools.linear_read({ path: "docs:linear-discovery" });
await tools.linear_search({
  path: "linear://your-workspace",
  query: "linear:issues login",
  limit: 10,
});
```

Use your workspace slug and follow a returned identity. To edit a body, read its displayed body link first with `views: ["anchors"]`, then pass that explicit path and a returned `line#hash` anchor or unique exact text to a standalone editor.

Standalone tools do not accept the IDE's `RESULT#`/`SEARCH#` handles. A partial Read grants only its returned text range; replacing a whole body requires reading the whole body. Read the saved resource again after each mutation. `linear_copy` links a document reference, and `linear_move` renames a document; neither is a general filesystem tool.

The [entry guide](docs/linear.md) explains how domain-guide examples map to standalone tool names.

## Safety and limits

- High-risk standalone actions always require interactive confirmation. There is no standalone YOLO switch; an unavailable UI, denial or cancellation prevents dispatch.
- In IDE mode, Linear uses the IDE's shared confirmation policy. Linear YOLO and remembered session grants can skip eligible dialogs, but never authorization, identity, payload, capability or freshness checks.
- A confirmed save succeeds even when Linear normalizes Markdown or field values. Read the saved representation before another edit.
- An unknown outcome may already have changed Linear. Inspect the same target before considering another operation; do not blindly replay it.
- Text bodies and text search are bounded to 2 MiB. Local upload files must be regular files, not symlinks, and at most 25 MiB. Upload and attachment changes are separate effects.
- Selected PDF and image attachments use shared SDK converters. Unsupported binary/archive formats are not extracted; the package performs no OCR or transcription.

Read [access and recovery](docs/linear-access.md) before changing permissions or handling a stale save. Credentials stay with AXI; the extension does not forward them to arbitrary attachment hosts or unvalidated redirects.

## Guides

Use `docs:` to list the registered guides. The [entry guide](docs/linear.md) links to discovery, issues, projects, documents, discussions, files, organization, releases, activity, workflow, review and access. In IDE mode, the first matching operation can also carry the short entry guide; full domain guides stay opt-in.

The package provides Linear access only. It ships no project-management workflow or skills; agents bring their own. The [workflow guide](docs/linear-workflow.md) covers the native Agent Skill and template routes such a workflow can publish through.

## Feedback

Report defects in the [Pi Agent IDE issue tracker](https://github.com/alexshpunt/pi-agent-ide/issues).

## License

[MIT](LICENSE). The bundled AXI backend is based on [Linear AXI v0.3.1](https://github.com/nikolauska/linear-axi/tree/v0.3.1) and retains its own MIT copyright and license notice.
