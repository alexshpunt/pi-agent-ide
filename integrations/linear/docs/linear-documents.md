# Linear documents

A document is an editable text artifact, not a binary attachment. Open a displayed stable `linear://<workspace>/document/<UUID>` link or its native Linear URL.

## Create

Use Write with an explicit parent and title:

```js
await tools.write({
  path: `linear://${workspace}/issue/${issueId}/documents/new?title=${encodeURIComponent("Workpad")}`,
  content: "# Workpad\n\nFirst note.\n",
});
```

The project form uses `linear://<workspace>/project/<UUID>/documents/new?title=...`. Other advertised parent kinds follow their own creation contract. Use the returned parent link; do not invent a UUID or assume all containers support the same action.

A confirmed create returns the known document identity and Read link. Keep these even if a later read fails. Each create is a new record, not an upsert by title. Read the returned document before editing. An unknown create may already have saved it; do not create another document to recover a missing readback.

## Delete

Use Delete on the verified whole-document address, `linear://<workspace>/document/<UUID>`, after approval. Do not target its content, fields or schema. The native `documentDelete` operation moves the document to Trash and archives it; it does not permanently purge it.

Deletion uses the typed destructive-action gate. Without the IDE, an interactive confirmation is required; headless Delete is refused. After an uncertain result, inspect the same UUID rather than sending Delete again. A failed read or permission denial does not prove the document was deleted.

## Edit only the body

The card exposes `linear://<workspace>/document/<UUID>/content`. This contains the saved body without title, metadata or linked-resource headers.

Read it with `views: ["anchors"]`. With the IDE, use actual anchors, unique text or unchanged Read and Search selections with Replace and Insert. Without the IDE, use linear_read and its own line#hash anchors or unique exact text with the standalone editors. Use explicit resource paths in standalone mode. Whole-body Write requires reading the whole body. A returned selection grants only its source and range. Reading a card does not grant edit authority over its linked body.

The provider stages and saves text internally. Body text is limited to 2 MiB. For a separate paragraph, use Insert with `separation: "blank-line"`.

After saving, Read the body again before another edit. Use Linear's saved representation and fresh shared selections, not the text sent in the write. Remote mutation receipts do not grant a reusable text selection. Linear's transformations do not turn a confirmed write into a failure. Read [Access and recovery](docs:linear-access) for confirmed writes, failed readback and uncertain delivery.

## Rename and attach

Move renames a document through its documented rename target. Use the target returned for that document with the intended new title. The UUID, body and parent stay the same; reread the returned link to verify the title.

```js
const document = `linear://${workspace}/document/${documentId}`;
await tools.move({
  path: document,
  target: `${document}?title=${encodeURIComponent("New title")}`,
});
```

Use the verified document UUID for both addresses. The title query is a rename request, not a new document identity.

Copy a document into a supported target attachment/resource collection to add a reference to the same document. This does not clone its text, reparent it or remove its original references.
Issue and project `#attachments` collections accept Copy references. For example:

```js
await tools.copy({
  path: document,
  target: `linear://${workspace}/project/${projectId}#attachments`,
});
```

The project path adds an external resource link and verifies it alongside existing resources. Reading the collection lists links without reading their bodies. A local-file Insert is currently issue-only; it is not a project binary-upload shortcut.

Use only advertised destination operations. Read [Files](docs:linear-files) for binary and link attachments, or [Discussions](docs:linear-discussions) for the document's comments. Read [Access and recovery](docs:linear-access) before handling a stale or uncertain save.
