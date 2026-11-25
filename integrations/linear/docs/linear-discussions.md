# Linear discussions

Read `<card-url>#comments` to open that card's discussion. The backend supports different parents, including issues, projects and documents; use the discussion link exposed by the selected resource.

## Read all pages

A discussion page contains full comment bodies and individual comment references. Read each exact next-page link until the result is complete. Line offsets select text within a page; they do not request another API page.

An empty discussion, an inaccessible discussion and an incomplete page are different results. Do not infer absence from partial coverage or construct cursors yourself.

Search the discussion resource or a selected comment to match its own text. Card Search does not silently include discussion bodies. A phrase found in native issue discovery may occur only in a comment.

A known issue comment has a stable contextual link:

`linear://<workspace>/issue/<identifier>/comment/<UUID>`

Read a displayed individual link rather than searching every comment to guess its identity. Known-comment lookup is bounded; an incomplete lookup is not proof of absence.

## Add or change a comment

For a new issue comment, Write to:

`linear://<workspace>/issue/<identifier>/comments/new`

Content is the comment body. A confirmed call returns the created UUID and Read link; keep them even if a later read fails. Read the saved body before editing it. Each successful call creates one comment; an unknown create must not be repeated blindly.

Other parents and existing-comment edits use their own advertised resources. Read the body before using ordinary editors. Keep the parent and comment identity explicit. Changing a comment must not replace the whole discussion or create another comment instead.
A displayed comment has an editable `#body` link. For other parents, read `linear://<workspace>/comment/new` and Write typed JSON, for example `{"projectId":"<verified-project-id>","body":"A comment"}`. A specific comment also exposes `linear://<workspace>/comment/<UUID>#fields` for schema-validated updates. Omit `id`: it is bound by the URI.

Contextual issue comments use the selected connection's own identity. Personal keys and user OAuth write as that user; App connections write as the application. Legacy persona files and role variables are ignored, including malformed configuration. Requests never send author-name or avatar overrides, switch connections or fall back to another credential.

Before a managed connection is selected, legacy operator mode retains its configured MCP/app routing. Typed comment actions use MCP authorization. Existing comments keep their authors; read access and an app grant do not prove permission to edit another actor's comment.

A failure before mutation reports `not-applied`. Once a mutation has been dispatched, an unconfirmed result reports `unknown`; do not resend it automatically. Authorization failures and redirects do not trigger refresh, replay or alternate routing. Failure codes and bounded retry metadata exclude private backend messages. A confirmed UUID remains `applied` without a readback dependency.

Deletion requires permission for that exact comment. A discussion read or a broad request for full access is not deletion approval.

Next: [Discovery](docs:linear-discovery) for exact shared ranges, or [Access and recovery](docs:linear-access) for freshness, confirmed writes and uncertain delivery.
