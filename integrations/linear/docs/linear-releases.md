# Linear releases and status updates

Use this guide for releases, release notes, release pipelines and project/initiative status updates. Do not load review instructions merely to read a release.

## Read and discover

Read the selected release's displayed resource links. Directory discovery follows the backend's name/version query and pagination; it is not a promise of full-text search for every release field.

Release notes, pipeline records and status updates have their own identities and parents. Open the relevant resource before searching its text. A status update discussion is separate from the update body.

## Save supported values

Use explicit creation or field/body resources for supported saves. Read their typed contract first: a release, a release note and a project status update do not share one payload format.

Write replaces the selected value or body. Insert adds items only where the resource advertises addition. Reread an acknowledged save to verify identity, parent and changed fields. Preserve unrelated records.

Issue release membership is a task field. Set, add and remove have different semantics; use [Issues](docs:linear-issues) rather than editing a release card to change membership.

Deletion of a status update requires permission for the exact update. Pipeline reads do not grant authority to invent deployment actions absent from the backend.

Next: [Discussions](docs:linear-discussions) for update comments, or [Access and recovery](docs:linear-access) for permissions and uncertain effects.
