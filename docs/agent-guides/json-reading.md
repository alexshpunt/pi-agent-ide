# Read JSON with jq

Use a `jq:` view when a JSON resource is too large or you need a structured subset.

```json
{ "path": "package.json", "views": ["jq:.scripts"] }
```

The text after `jq:` is a normal jq filter. It is passed as one argument to the installed `jq` executable, while the selected resource is sent through standard input.

## Common filters

```text
jq:.
jq:.dependencies | keys
jq:.users[] | select(.active) | {id, name}
jq:[.items[].price] | add
```

A filter may produce no values, one value, or several values. Output keeps jq's normal pretty-printed JSON form.

## Read part of the result

`offset` and `limit` select lines from the transformed jq output, not from the original file.

```json
{ "path": "large.json", "views": ["jq:.items"], "offset": 101, "limit": 100 }
```

Follow the continuation offset returned by Read. Oversized complete output may also provide a temporary resource.

## Limits

- Supply exactly one non-empty `jq:` view.
- Do not combine `jq:` with annotation views. Their source coordinates would not describe the transformed JSON.
- The resource must contain valid JSON.
- jq must be installed and available on the project or system `PATH`.
- Module loading is disabled. The process receives only a minimal environment and the selected JSON on standard input.
- Execution is limited to five seconds and 10 MB of jq output.

Use ordinary Read when you need the original source lines or anchors. Use the jq view for inspection and computation only; it does not edit the file.
