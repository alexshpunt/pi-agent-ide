# Select source boundaries

Use Search to find code by a predicate. Use Select when an existing target needs new structural boundaries. Ordinary JavaScript chooses returned items; it cannot grant source authority to reconstructed coordinates or strings.

## Supported operations

Select currently supports JavaScript (.js/.mjs/.cjs) and TypeScript (.ts/.mts/.cts), without JSX/TSX. Syntax errors and unavailable providers are errors, not evidence that a function is absent.

- `operation: {kind:"object", object:"function", relation:"enclosing", level:1, extent:"around"}` returns the nearest function containing the entire input range. An exact function selects itself. It can expand outside a Read/Search window and reports each input range and whether expansion occurred. A seed spanning separate functions is rejected rather than choosing from its first character.
- `operation: {kind:"part", part:"body"}` requires an exact supported function target. A block body includes braces; an expression-bodied arrow returns its expression. A declaration without a body produces no selection, reported by missingInputs.

Function declarations/expressions, arrow functions, class/object methods and their async/generator forms are supported, including TypeScript signatures without bodies. A function's parameters belong to that function, including default expressions. No lexical text objects, ownBody subtraction, arbitrary ranges, other nesting levels or general AST traversal are implemented.

## Source inputs and results

path accepts compatible Read/Search/mutation/Select results, their data, RESULT# references and arrays of returned items. A file path obtains a fresh whole-file Read snapshot; the chosen operation still must make sense for that entire seed. A multi-function file is not implicitly split into functions.

The result has kind selection, a complete stored target, items with individual targets, exact ranges and original-input associations, complete, totalItems, missingInputs and truncated. Lines are one-based and columns are UTF-16; character ends are exclusive. Identical output geometry is deduplicated while origins retain the separate input ranges. Empty results remain valid source sets. Unsupported part inputs, ambiguity and stale/expired inputs are errors.

Items are limited to 100 and each text preview to 1000 UTF-16 code units. truncated describes presentation, not execution completeness. The top-level target retains all selected ranges. complete inherits input completeness; an incomplete result cannot establish absence or safely authorize edits. Source snapshots stay strict: refresh Read/Search after edits, session changes or reload. Select never writes or runs formatting.

## Compose with existing tools

```js
const calls = await tools.search({ path: "client.ts", query: "ast:legacyRequest($OPTIONS)" });
const owners = await tools.select({
  path: calls,
  operation: {
    kind: "object",
    object: "function",
    relation: "enclosing",
    level: 1,
    extent: "around",
  },
});
const body = await tools.select({
  path: owners.data.items[0],
  operation: { kind: "part", part: "body" },
});
const retry = await tools.search({ path: body, query: "ast:retry($$$ARGS)" });
```

A body includes nested functions. To test for retry in that function's own body, select each retry call's nearest enclosing function and compare its source/range to the original owner. This keeps outer retry calls containing callbacks while excluding calls in nested functions or their default parameters. Do not establish absence from incomplete Search or clipped items.

For the initial timeout scenario, retain the original legacyRequest calls associated with eligible owners, use AST captures for inline object-literal options and their direct timeout values, preview, then replace only those values. Do not edit unrelated or nested-object properties, resolve variables, or imply semantic identity from a syntactic call name.

Search and compatible edits consume selection results through their stored targets. Read keeps its existing string-path schema: pass the result's target (for example, `read({path:body.data.target})`), not the whole object. Its whole-line context does not change the exact selection target. Whole-file write/undo still reject partial selections; selection never widens their guards. insert keeps its existing string/anchor contract. Formatting at the end of a native Codemode script may invalidate earlier selection targets just like other source results.
