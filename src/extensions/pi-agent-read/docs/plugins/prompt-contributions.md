# Read parameter descriptions

## Purpose

Read plugins document their source and view syntax beside the matching tool parameter. This metadata describes installed capabilities. It does not register a resolver, enable a view, grant permission or change argument validation.

System-prompt rules use `api.addPromptGuideline()`. Complex workflows and worked examples belong in packaged guides.

## Declaration

A plugin calls `api.describe()` once with a non-empty map:

```ts
api.describe({
  path: () => describeCurrentSourceFormats(),
  views: "outline — declarations alongside source text.",
  offset: "For this source, offset counts from the selected declaration.",
  limit: "For this source, limit is the maximum number of source lines.",
});
```

The keys are `path`, `views`, `offset` and `limit`. Each value is a non-empty string or a synchronous callback returning a string or `undefined`.

Describe every parameter whose meaning the plugin changes. Put protocol syntax on `path`, view syntax and settings on `views`, and source-specific coordinates and units on `offset` and `limit`. Include defaults, restrictions, permissions and dependencies where they affect a call. Parameterized views remain strings, not a closed enum of names.

## Registration and snapshots

Metadata registered during setup is committed only after setup succeeds. Pending and rejected plugins contribute nothing. A retained API can make its one description registration after setup.

Core evaluates callbacks when a schema snapshot is requested. Returning `undefined` omits that parameter's contribution. Callbacks can inspect the current content-provider graph or configured defaults. Earlier snapshots do not change.

Accepted registration order determines description order. Exact duplicate descriptions are omitted per parameter. The base schema stays unchanged; each snapshot appends plugin text to the matching base description.

Pi wraps tool definitions into schema snapshots. The Read adapter waits for pending plugins and refreshes the registered definition before an active Read agent run starts. It does not replace metadata in an in-flight request. Other callers that inspect the definition also request fresh snapshots.

## Validation

Core rejects unknown keys, an empty map, empty static text and a second description map from the same plugin. Static text is normalized during registration; callback results are normalized during snapshot construction. Normalization removes surrounding blank lines and trailing whitespace and uses LF line endings.

A callback that throws or returns a non-string value other than `undefined` fails snapshot construction. Invalid metadata is not silently hidden.

Descriptions are trusted extension-provided context. Do not include secrets, credentials, unrelated global instructions or benchmark-specific hints.

## Testing contract

Core tests check parameter placement, unchanged input validation, lazy snapshots, setup transactions and invalid metadata. Real-Pi tests inspect the schema delivered to the scripted provider, including late registration, current defaults and disabled-plugin exclusion.
