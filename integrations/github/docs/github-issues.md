# Issues and ordinary comments

Read the native issue URL or a displayed github: link. The card returns its editable #body, #fields, #schema and #actions separately.

Use Read with anchors on #body, then normal Replace/Insert/Write. Cards themselves are read-only. For metadata, read the relevant field or #fields and its #schema, then Write. String fields use plain text; arrays, booleans, numbers and objects use JSON. Reread after saving. Existing shared selections are valid only while their owning snapshot matches.

Creation uses Write with JSON at the displayed issues/new address. Read it for the exact schema. A comment is a separate resource; issue and PR conversation comments use issues/<number>/comments/new with JSON body. Read the returned identity before editing #body. Do not confuse ordinary comments with inline PR review comments.

Labels and milestones have their own readable collections and typed creation/field resources. Use displayed identities; do not edit a card as if it were a JSON record.
