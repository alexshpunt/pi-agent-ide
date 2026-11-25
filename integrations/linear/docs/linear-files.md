# Linear files and attachments

An attachment is a reference on a card. Its target can be a document, private uploaded file or external URL. Editing a document's text is different from replacing a binary file.

## Read the selected target

A card lists attachment links, not their bodies. Open the displayed link separately.

Private file links returned by this package use `linear://<workspace>/asset?url=...`. They provide authorized Read. A known attachment UUID can be addressed by its displayed attachment-resource link; the provider resolves its current target.

External links retain their own provider and access rules. Linear credentials are never forwarded. A signed external URL can expire; do not treat it as a permanent authorized storage identity.

UTF-8 text is readable. PDF and image conversion uses the shared SDK converters in an isolated worker. Types are detected from bytes, so extensionless upload URLs work. Conversion is bounded to two minutes and 25 MiB output. ZIP and unsupported binary formats are not extracted; there is no OCR or transcription.

With IDE Read, prefix the displayed asset address with `raw:` for exact original bytes; offset and limit are byte counts. Raw Read can be inspected in Codemode. Standalone linear_read exposes the asset's supported converted content, not the IDE's raw-byte view. File access is bounded to 25 MiB.

## Add an existing resource

Copy a resource to the target's supported attachment/resource collection, such as `cardUrl + "#attachments"`. This adds a reference. It does not upload again, clone document content, move its parent or remove other references.

Read the destination's contract first. A container may not support issue-style attachments. Do not reinterpret an unsupported Copy as a successful text edit.

## Add a local file

Insert into the supported `#attachments` collection using its documented local-file reference format. The provider uploads bytes and attaches the result internally. The inserted value is transport input, not literal Markdown or base64 binary content.

```js
await tools.insert({
  path: issueUrl + "#attachments",
  after: "end",
  text: JSON.stringify({ file: ".tmp/report.pdf", title: "Report" }),
});
```

In standalone mode, pass `anchor: "end"` to `linear_insert` instead of `after`.

A `file:` reference is also accepted. Use `file:` or a JSON object; a bare pathname is not inserted as attachment content.

The source must be an existing local regular file, at most 25 MiB. Symlink inputs are refused. Original bytes are preserved; the receipt reports byte count and SHA-256. The local source is not moved or deleted.

The dedicated `linear_upload` tool remains available for upload-only work or an explicit issue attachment. Without an issue, it does not change a card. Its result supplies the private asset and Read link.

## Replace one attachment

Write a local-file reference to the specific attachment's advertised file resource, such as its `#file` target. This replaces that card's attachment, not the stored binary content in place. Insert still means addition.

```js
await tools.write({
  path: `linear://${workspace}/attachment/${attachmentId}?issue=${issueId}#file`,
  content: JSON.stringify({ file: ".tmp/new-report.pdf", title: "Updated report" }),
});
```

Use the displayed attachment UUID. An explicit issue is required if the attachment response does not expose its parent; it must match the original attachment.

The provider uploads and verifies the new asset/attachment before removing only the old attachment from this card. The attachment ID can change. The old asset and its other references remain intact.

Upload, new attachment and old-link removal are separate effects. A failure after upload must retain the new asset link. A failure to remove the old attachment can leave both references. Report partial outcomes; do not repeat the whole operation blindly.

Next: [Documents](docs:linear-documents) for text bodies, or [Access and recovery](docs:linear-access) for approval, access and uncertain outcomes.
