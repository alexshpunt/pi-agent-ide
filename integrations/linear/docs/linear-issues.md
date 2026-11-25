# Linear issues and child issues

Read the user's issue URL first. Its card identifies the task and exposes separate resources for its body, fields, discussion and attachments.

## Read and search

Search for tasks using [Discovery](docs:linear-discovery). To list tasks by status, label, assignee or priority, use its filtered GraphQL query, not text search. Never build a list by reading identifiers one at a time. To find direct child tasks, use the parent issue as the discovery scope. The parent must be verified; a matching task elsewhere is not a child.

Read each returned child link. Follow exact continuation links when the result is incomplete. Do not silently include grandchildren or search every linked resource.

Use `issueUrl + "#comments"` for the discussion, then read [Discussions](docs:linear-discussions). Read attachments through their own displayed links.

## Create a task

Read `linear://<workspace>/issue/new` for the live creation schema. Write a JSON object there, for example `{"team":"ENG","title":"A task","parentId":"ENG-123"}`. Omit `parentId` for a top-level task. URI identity fields are bound by the provider; do not put an update `id` into the payload.

Use the creation resource returned for the intended team or parent, not an existing task's description. Write the required typed creation fields in its documented format. A title and explicit team are required unless an API-supported template supplies them. A child creation also identifies its parent.

An acknowledged creation returns the actual issue identity and Read link. Read it to verify the title, team, parent and body. For an unknown result, follow [Access and recovery](docs:linear-access): inspect possible matches, retry if none can be confirmed, and clean up duplicates created by your attempts. A title match alone does not establish that an issue is a duplicate.

## Change one field

Fields are separate from body text:

```js
await tools.read({ path: issueUrl + "#status" });
await tools.write({ path: issueUrl + "#status", content: statusValue });
```

Write the field directly; no prior Read is required. Status names or IDs must resolve in the issue's team. Do not assume project statuses and issue statuses are interchangeable.

Write to `#labels` replaces the specified label set. Insert adds supported labels without removing existing ones. Read the field's accepted format and use verified label identities. Explicit removal is different from addition.

Use `insert({path: issueUrl + "#labels", after: "end", text: labelName})` to add a label, including the first label in an empty set. In standalone mode, pass `anchor: "end"` to `linear_insert` instead of `after`. The provider checks the current set before saving.

Other supported fields follow the selected issue's typed contract: assignee, priority, dates, parent, project, cycle and relations can have different value and clearing rules. Use only advertised fields. Several fields can be changed in one call by writing a JSON object to `issueUrl + "#fields"`, for example `{"state":"In Progress","assignee":"me","delegate":"agent-name"}`. Do not put metadata lines into the description and expect them to change fields.

Use `#estimate` for the team's numeric estimate value; zero is a value, not a clearing instruction. Write explicit JSON `null` to clear a nullable estimate or assignee. A missing estimate in a backend response is not treated as null. AXI reads that missing field through its separately authorized Linear App and verifies the workspace and Issue identity. An unavailable field read is an error, not a guessed value; it does not undo an already confirmed write.

Read `#milestone` for acquired milestone metadata. A reference retains its identity and name; an acquired string remains a string. Only an explicit `null` means no milestone is assigned. An omitted, unsupported or invalid field returns an error, not `null` or a text-anchor lookup. This Read does not fetch the linked milestone or change it. The Read value is not a mutation payload: use `#schema` for the accepted write format.

## Edit the description

The displayed `/description` body link contains only Markdown. Read it with anchors and use Write or the span editors. With the IDE, preserve the exact ranges issued by Read and Search. Standalone editors use explicit paths and their own line#hash anchors or unique exact text. Read the saved body again before another edit.

A pre-save check can detect a conflict but is not an atomic remote compare-and-swap. A confirmed write succeeds even when Linear changes the saved representation. Use the actual saved body for later reads and edits. Read [Access and recovery](docs:linear-access) for failed readback and uncertain delivery.

Next: [Documents](docs:linear-documents) for text artifacts, or [Files](docs:linear-files) for attachment operations.
