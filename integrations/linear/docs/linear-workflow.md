# Native Agent Skills and managed template content

These routes read and update Linear's native shared Agent Skills and the content of existing templates. The package ships no workflow of its own: project-management skills that publish through these routes live outside it.

## Native shared Agent Skills

The fixed native routes below use the CLI's existing Linear App authorization. They do not grant extra permissions and are distinct from the existing read-only MCP `agent-skill` routes.

Read a team-scoped collection:

```text
linear://<workspace>/workflow-skills?teamId=<verified-team-UUID>
```

Follow the returned continuation unchanged. The team is required; an incomplete page is not a complete inventory.

Read a selected native skill and its current schema:

```text
linear://<workspace>/workflow-skill/<UUID>
linear://<workspace>/workflow-skill/<UUID>#body
linear://<workspace>/workflow-skill/<UUID>#schema
```

Read `linear://<workspace>/workflow-skill/new` for the creation contract. Creation takes the verified team, title and Markdown body. A later body edit targets the same UUID. These are real Linear Agent Skills, not documents with a similar title. Shared skills are visible under the team's **AI & Agents → Agent skills** settings; team permissions may refuse publication.

## Managed template content

Read an existing template through its native content route:

```text
linear://<workspace>/workflow-template/<UUID>
linear://<workspace>/workflow-template/<UUID>#fields
linear://<workspace>/workflow-template/<UUID>#schema
```

Write only the advertised `descriptionData` document and, if needed, the help `description`. The help description is not the template body. The CLI merges managed content into the existing template data and preserves the template's identity, type, name, scope, title placeholder and other properties. Read [Organization](docs:linear-organization) for native issue/document template creation and application. Creation has its own schema at `/workflow-template/new`; existing-template writes retain the update-only contract.

Do not assume a template's Markdown display is its stored representation. Native template bodies use a ProseMirror document. Reject unsupported content during conversion rather than dropping it silently.

## Delete a shared skill or template

Use Delete on the verified `linear://<workspace>/workflow-skill/<UUID>` or `linear://<workspace>/workflow-template/<UUID>` address after approval. The existing `template/<UUID>` address also supports template deletion. Both issue and document templates use the same typed operation. Do not target body, fields or schema fragments. Generic read-only `agent-skill` resources do not gain Delete support.

Workflow skill deletion requires a verified team-bound, non-inherited record. The workspace-wide `shared` flag is separate and may be false. Personal skills without a team stay unsupported; deletion does not change sharing settings.

The typed destructive-action gate requires approval for the exact resource. Without the IDE, Delete requires interactive confirmation and is refused headless. Retain the exact UUID and receipt. An uncertain result may already have removed the resource; inspect it without repeating Delete. Permission failures and failed reads do not establish absence.

## Write boundaries

Native Delete operations use the selected App connection and verify its workspace and target. They do not use MCP credentials as a fallback.

Verify workspace, team and target identities before changing a skill or template. Missing target identities are a blocker, not permission to adopt matching titles or bootstrap new templates. Never overwrite unrelated resources by matching a title.

Read back saved content. Unchanged source reuses the same identities and needs no write.

A refused native operation is not permission to switch credentials or expand scopes. An uncertain mutation is not permission to retry. For an uncertain skill creation, retain the reported UUID resource and read it for recovery. Report partial completion honestly; see [Access and recovery](docs:linear-access).
