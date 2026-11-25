# Linear organization and directories

Use this guide for teams, users, labels, workflow statuses, cycles, milestones, saved views and templates. These resources do not all have the same writable fields.

## Find and read

Use directory Search with an explicit workspace or supported parent:

- Teams: workspace name/key lookup.
- Users: name/email lookup; team scope where supported.
- Labels and saved views: workspace or team name lookup.
- Cycles and issue statuses: a team is required.
- Milestones: a project is required.

These are actual API query/list operations, not universal full-text search. Follow displayed pagination links and readable identities. Search text only after selecting the resource. See [Discovery](docs:linear-discovery).

Native team pages expose overview, issues and projects. Pinned team resources are not exposed by the current backend. An empty team with no issue/project witness cannot establish its workspace through the older team-page path; use an advertised verified directory resource instead of guessing.

Templates are distinct resources. Read a template and its parent before using it to create an issue or project. Template defaults and explicit fields can interact; inspect the creation contract rather than assuming every field merges.

## Create and edit native templates

Read `linear://<workspace>/workflow-template/new` for the current creation schema. Write JSON there to create an issue or document template through the existing Linear App authorization:

```json
{
  "name": "Bug report",
  "type": "issue",
  "title": "Bug: <summary>",
  "description": "Record a reproducible defect.",
  "descriptionData": {
    "type": "doc",
    "content": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "Reproduction steps" }] }
    ]
  },
  "priority": 3
}
```

The body is a ProseMirror document in `descriptionData`. The help text is `description`; `title` is the default title of an object created from the template. Use `type: "document"` for a document template and omit `priority`. Set `teamId` to a verified team UUID for team scope, or omit it for workspace scope.

Read the returned UUID resource and its `#fields` before editing. Write only the advertised fields. Existing templates support body and help-text edits while retaining identity, name, type, scope and other defaults. Do not supply an identity in a creation payload.

Apply issue templates through ordinary issue creation's `template` field. For documents, read the saved native template's Markdown `content`, then use that content in ordinary document creation. The current MCP document creation schema has no automatic template argument.

Permissions can refuse creation or editing, even when the schema is advertised. A returned correlation UUID identifies an uncertain creation for recovery; read that target. Never replay an uncertain creation, even when no target was returned. These operations do not change credentials, scopes, default templates or unrelated resources.

## Work with supported fields

Read the selected resource's writable fields and action resources. Statuses belong to their workflow scope; labels can be issue labels, project labels or groups. Do not apply a label group directly to an issue or treat names as globally unique.

Write replaces a typed field; Insert adds collection items only where supported. A label save, retire or restore is different from adding/removing a label on a task. Some directory resources are read-only; a listed object does not imply a save operation exists.

Milestone changes must preserve the verified project. Read team/user metadata and triage responsibility without inventing unsupported administration operations.

Retiring a group can affect its children. Retirement, deletion and other high-risk actions require approval for their concrete target and scope.

Next: [Issues](docs:linear-issues) for issue fields, [Projects](docs:linear-projects) for project fields, or [Access and recovery](docs:linear-access).
