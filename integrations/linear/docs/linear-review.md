# Linear review and diffs

Read this guide only when the task concerns a diff or review action. Ordinary issue/project work does not need it.

## Inspect first

Read the selected diff, its parent/context and the relevant thread links. List operations return identities and pages; they do not authorize a review or merge.

Search the selected readable diff or comment text. Use returned identities instead of guessing repository, diff or thread IDs. A thread discussion is separate from the diff body.

## Review actions

Comments, thread resolution and review submission use their own typed resources. Read the advertised contract before using Write, Insert or an editor. Updating a diff must preserve its verified identity and intended scope.

A diff comment is not an issue comment. Read its parent and body before editing or deleting it. An uncertain comment save is inspected rather than repeated.

## Approval is required for high-risk effects

Merge and other high-risk actions require permission for the exact target and action. A request for full Linear access, a review read or a test fixture is not blanket approval.

In IDE mode, use the shared approval policy described in [Access](docs:linear-access). A configured YOLO or remembered session grant can authorize dispatch without UI. Without either, unavailable UI refuses. In standalone mode, high-risk actions always require interactive confirmation, regardless of IDE settings or remembered grants. Do not work around a refusal. Refusal before dispatch means no mutation was sent; a failure after dispatch can be uncertain. Keep those outcomes distinct.

Do not merge a real diff or delete records as automatic verification cleanup. Use controlled transport checks where live execution would affect external work, and report unperformed live checks honestly.

Next: [Discussions](docs:linear-discussions) for comment bodies, or [Access and recovery](docs:linear-access) before handling permission or transport failure.
