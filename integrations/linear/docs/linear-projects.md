# Linear projects

Read the native project URL. A project card returns its description and resource links; linked bodies remain separate.

Use [Discovery](docs:linear-discovery) to find projects or tasks within a project. Project-scoped text matching searches the card itself; object discovery finds records in that container.

## Create a project

Read `linear://<workspace>/project/new` for its live schema, then Write a JSON object such as `{"name":"A project","setTeams":["ENG"]}` to that exact resource. The receipt provides the saved identity.

Use the explicit project creation resource returned for the intended workspace/team. Write its typed creation fields, including the required name and team membership. Do not use a hidden default team or treat a description write as project creation.

Read the canonical identity returned after an acknowledged creation. Verify its name, teams and supplied fields. Do not repeat an uncertain creation just because no receipt arrived.

## Change project fields

Read a specific field before writing it. A fragment such as `#status` exposes the project's status contract; issue workflow states are not interchangeable with project states.

Write replaces the addressed value. Insert adds items only for fields that support addition. Team membership, labels, priority, dates, lead and summary have their own types and limits. Changing one field must not overwrite the description or other fields.

The displayed `/description` link is body-only Markdown. Read it with anchors and use the ordinary editor tools. Read again after a save before another edit. See [Access and recovery](docs:linear-access) for concurrency, confirmed writes and saved representations.

## Documents and discussions

Use the project's displayed document creation resource to create an artifact. Read [Documents](docs:linear-documents) for body edits and rename.

Copy an existing resource to a supported project resource collection only if the destination advertises that operation. Adding a reference is not moving the document's parent. An issue attachment API does not imply that every project accepts the same attachment operation.

Use the project's comments fragment when that discussion is exposed. Read [Discussions](docs:linear-discussions) for pages and individual comments. Releases and project status updates are covered by [Releases](docs:linear-releases).

Deletion and other high-risk changes require approval for the exact target and action. Creating a test project does not authorize deleting it afterward.
