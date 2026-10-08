# Select source boundaries

Use Search to find text or code by a predicate. Use Select when an existing target needs new text or structural boundaries. Ordinary JavaScript chooses returned items; it cannot grant source authority to reconstructed coordinates or strings.

## AST operations

AST operations support JavaScript (.js/.mjs/.cjs) and TypeScript (.ts/.mts/.cts), without JSX/TSX. Syntax errors and unavailable providers are errors, not evidence of absence. Text operations do not require a parser.

### Enclosing constructs

Use `{kind:"object", object:"function"}` to find the nearest function containing the entire seed. An exact function selects itself. Set level:2 for the next outer function; levels count only the requested category. The optional relation/extent spellings remain enclosing/around. Enclosing can expand outside a Read/Search window and reports each input association and expansion. Seeds crossing a construct boundary or separate constructs are rejected instead of choosing from their first character. Narrow an exported declaration match to its function node or name before enclosing; the export wrapper is not a function node.

Supported object categories:

- function: declarations, expressions, arrows, class/object methods, async/generator forms and bodyless TS signatures. Default parameter expressions belong to their function.
- call: calls and new expressions.
- class, if, switch, loop (for/for-in/for-of/while/do), try and catch.
- binding: a variable declarator, not the surrounding const/let/var statement. assignment: ordinary and compound assignment expressions.
- object/array: literals and destructuring patterns; property: key/value pairs and shorthand object properties.
- return and throw.

These are syntax categories, not resolved symbol identities. Parser-only wrappers, punctuation, type nodes and comments do not become extra public construct categories. Class fields, JSX/TSX and other unlisted forms are not promised as constructs. ownBody is not implemented.

### Navigate

Use `{kind:"navigate", relation:"parent"}` on an exact named syntax node. Returned constructs skip parser-only wrappers. Exact part/capture targets can be used directly; if a text range cuts through a node, first use object/enclosing. When several nested nodes have identical bounds, the supported construct takes precedence; otherwise the innermost exact named node is the starting node. A whole-file seed is not implicitly split into constructs.

- parent returns the nearest normalized construct ancestor, excluding the starting node.
- ancestors returns all normalized ancestors in source order, excluding the starting node.
- children returns the nearest nested constructs. descendants returns all nested constructs. Neither includes the starting node.
- siblings requires an exact normalized construct. direction previous/next returns its immediate neighbor under the same normalized parent; omit direction or use all for every other sibling. Top-level constructs share the document root. Missing parents/neighbors are valid absence.

Set object to filter results by category after navigation. A filter never changes topology: parent with object:function does not jump past an intervening call; children with object:call does not jump through an if. previous/next do not skip a different-category neighbor. Use ancestors/descendants when deeper matching constructs are wanted.

Ancestors and descendants can overlap. Choose the intended disjoint targets before editing; edit tools still reject overlapping writes. JavaScript chooses items by syntax.object or source/range; the item's stored target supplies source authority.

### Named parts

Use `{kind:"part", part:"arguments"}` on an exact construct. Parts retain provider boundaries and delimiters: a function block body includes braces, parameter/argument lists include parentheses, return/type annotations include their colon, and an else/finalizer clause includes its keyword. A single unparenthesized arrow parameter has no invented parentheses; an expression arrow body is its exact expression.

| Construct                                 | Supported parts                                            |
| ----------------------------------------- | ---------------------------------------------------------- |
| function                                  | name, parameters, returnType, body                         |
| call/new                                  | callee, arguments                                          |
| class                                     | name, body                                                 |
| if                                        | condition, then, else                                      |
| switch                                    | condition, body                                            |
| classic for                               | initializer, condition, update, body                       |
| for-in / for-of                           | left, iterable, body                                       |
| while / do                                | condition, body                                            |
| try                                       | body, handler, finalizer                                   |
| catch                                     | parameter, body                                            |
| finally clause returned by part/finalizer | body                                                       |
| binding                                   | name, type, value                                          |
| assignment                                | left, right                                                |
| property                                  | key, value; shorthand selects the same identifier for both |
| return / throw                            | value                                                      |

A supported optional part that is absent produces no selection and increments missingInputs: anonymous function name, optional else, bodyless TS declaration, missing annotation, bare return, optional catch parameter, or new without arguments. Unsupported parts return an error listing available names. Objects and arrays do not invent a body or arguments part; use navigation for nested constructs and AST Search for scalar elements. For argument/parameter separator ownership, use elementExtent below; array/object list extents are not implemented.

Structural items include parser-derived syntax.object and, for part selections, syntax.part where a normalized owner exists. These labels are descriptive, not editable authority. Read takes the item's target string; its displayed line context never widens the exact part's source scope.

```js
const found = await tools.search({ path: "client.ts", query: "ast:send($$$ARGS)" });
const call = await tools.select({ path: found, operation: { kind: "object", object: "call" } });
const args = await tools.select({ path: call, operation: { kind: "part", part: "arguments" } });
await tools.read({ path: args.data.target });
const number = await tools.search({ path: args, query: "10" });
await tools.replace({ path: number, text: "20" });
```

## List element extents

Use `{kind:"elementExtent", extent:"inside"}` on an exact direct JS/TS call/new argument or parenthesized function/method/arrow parameter. AST captures can provide those element targets. Variadic captures may also contain punctuation; choose the element items in JavaScript before passing them here. Commas themselves are not elements. A typed/default parameter must include its type/default, not just its name. Partial expressions, whole lists, array/object elements and unparenthesized arrow parameters are unsupported; this operation never silently selects an enclosing element.

`inside` keeps only the element. `around` adds owned comma/whitespace, reports expansion and preserves list parentheses:

| Element                             | around includes                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| First or middle with a next element | Element through the next element's start, including the following comma and whitespace |
| Last with a trailing comma          | Element through the closing parenthesis, excluding the parenthesis                     |
| Last without a trailing comma       | Previous element's end through this element's end; keeps closing whitespace            |
| Only element                        | Entire list interior, including leading/trailing whitespace and any trailing comma     |

Both adjacent gaps must contain only the expected comma and whitespace for around. Comments in those gaps return AMBIGUOUS_LIST_TRIVIA instead of guessing their owner. Comments inside the element are retained. inside does not assign neighboring trivia and remains available when an around request is refused.

Example: `send(a, b, c)` selects `b, ` around b and `, c` around c. Removing either single extent preserves the comma structure. Several selected extents can overlap: edit tools still reject overlap; do not assume arbitrary bulk deletion is repaired. Source bytes and CRLF stay exact.

Copy/move transports precisely the selected bytes, not a refactoring. A following-comma extent can be inserted before an existing destination element; a preceding-comma extent can be inserted after one. Destination syntax, parameter ordering and semantic validity are the caller's responsibility. Read the extent's target to preview it before editing. No new edit input contract or implicit syntax repair is provided.

```js
const found = await tools.search({ path: "client.ts", query: "ast:send($FIRST, $MIDDLE, $LAST)" });
const element = await tools.select({
  path: found.data.matches[0].captures.MIDDLE,
  operation: { kind: "elementExtent", extent: "around" },
});
await tools.read({ path: element.data.target });
await tools.delete({ path: element });
```

## Text operations

Use `operation.kind` to choose a text transformation:

- `range` with startLine/startColumn/endLine/endColumn selects absolute source coordinates in one source. Lines are one-based, columns UTF-16 and the end exclusive. The entire requested range must fit one input region.
- `lines` with first/last selects inclusive absolute complete lines in one source, including their existing line endings. Require containment in one input region.
- `between` with non-empty literal start/end markers and extent inside/around/lines pairs the next opening marker with the nearest following closing marker, then resumes after that pair. inside excludes markers; around includes them; lines explicitly expands to complete containing lines. There is no nesting or bracket balancing. Identical markers pair successive occurrences. An unmatched opening is an error; no opening is valid absence.
- `sliceText` with non-negative from and optional to slices each region by relative UTF-16 offsets. to is exclusive and defaults to the region end. This slices source text, not the items array.
- `trim` with side start/end/both removes Unicode whitespace from those edges of each region. Whitespace-only input returns a zero-width point at its end.
- `split` with a non-empty literal delimiter returns segments without the delimiter. Empty segments remain zero-width points.
- `linesOf` explicitly expands each region to its complete containing lines. An exclusive end at next-line column zero leaves that untouched next line out.
- `position` with edge before/after returns each region's zero-width start/end. Use a whole-file Read for file edges.
- `columns` with from/to returns the exclusive UTF-16 column interval on each touched line, without line endings. Every interval must fit both its line and input scope.

Except for range/lines, apply each operation independently to every input region. Keep files and sparse gaps separate; markers or delimiters cannot span those gaps. Invalid bounds, short-line columns and boundaries inside surrogate pairs or CRLF are errors, not clipped ranges. Preserve original CRLF/LF/bare-CR endings and unterminated EOF. Only linesOf and between/lines explicitly expand text input and report expansion.

Resolve registered anchors through existing Read inputs, then pass their verified target to Select. Use Search for regex captures rather than a second regex language inside Select. Use JavaScript array slice/filter to choose items; use sliceText to derive source boundaries.

```js
const source = await tools.read({ path: "notes.txt", offset: 2, limit: 1 });
const inside = await tools.select({
  path: source,
  operation: { kind: "between", start: "<", end: ">", extent: "inside" },
});
const value = await tools.select({
  path: inside,
  operation: { kind: "trim", side: "both" },
});
await tools.read({ path: value.data.target });
await tools.replace({ path: value, text: "new value" });
```

Select works as an ordinary tool as well as inside native Codemode. A position can be consumed by replace or a paired copy/move destination for exact insertion. insert keeps its string-path/anchor contract.

## Range sets

Use path for candidates and operation.scopes for comparison scopes. Both accept verified results/data/targets/item arrays and readable source strings. Match sets by file and snapshot, never by array order; different files do not match. Every input is verified even when it has no counterpart. Stale or incompatible snapshots reject the operation.

- within retains a complete candidate only when one scope contains it. It does not clip or join adjacent scopes for containment.
- intersection clips each candidate to the union of comparison scopes.
- difference subtracts the union of scopes from each candidate and returns separate surviving fragments.
- merge explicitly joins overlapping candidates. Set adjacent:true to also join touching nonempty ranges; default false. Never fill a real gap.

Clipping/subtraction keeps different candidate seeds separate. Equal output geometry is deduplicated; origins retain the candidate associations, not comparison scopes. Merge retains every contributor and reports its expansion relative to each candidate.

A point belongs to a nonempty [start,end) range at its included start but not its excluded end. Equal points match. Intersection with an explicit point keeps that point when contained; touching nonempty text does not create a point. Difference removes covered candidate points, but subtracting a point does not cut text. Merge absorbs covered points and keeps other points separate without extending text or bridging gaps. EOF points are outside a range ending at EOF.

Empty comparison scopes make within/intersection empty and difference unchanged. Empty candidates stay empty. Binary output complete is the conjunction of both inputs, including unmatched comparison files. Incomplete scopes do not establish absence or authorize an edit. missingInputs counts candidates that produce no output.

```js
const candidates = await tools.search({ path: "notes.txt", query: "regex:<[^>]+>" });
const protectedText = await tools.search({ path: candidates, query: "KEEP" });
const editable = await tools.select({
  path: candidates,
  operation: { kind: "difference", scopes: protectedText },
});
const found = await tools.search({ path: editable, query: "old" });
await tools.replace({ path: found, text: "new" });
```

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
