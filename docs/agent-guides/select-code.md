# Select source boundaries

Use Search for predicates and existing captures. Use Select to derive new text or syntax boundaries. Pass the unchanged Read/Search/Select/edit result as `path`; ordinary paths and returned item references also work. Outside Codemode, you can pass the result's UUID.

Select returns readable selected text with item references. The whole result retains all selected ranges, even when its preview is shortened. Use a displayed item reference when you need only that item. Do not build a selection from copied preview text or invented coordinates.

## Syntax operations

Syntax operations support JavaScript (.js/.mjs/.cjs) and TypeScript (.ts/.mts/.cts), without JSX/TSX. Missing providers and syntax errors are errors, not evidence of absence. Text operations need no parser.

### Enclosing constructs

`{kind:"object", object:"function"}` selects the nearest function containing the entire seed. An exact function selects itself. `level:2` selects the next outer function; levels count only the requested category. A seed crossing separate constructs is rejected. Enclosing can expand outside the original window and reports that expansion.

Supported categories: function, call, class, if, switch, loop, try, catch, binding, assignment, object, property, array, return and throw. Call includes new expressions. Function includes methods, arrows, async/generator forms and bodyless TS signatures. Default parameter expressions belong to their function. Binding selects one variable declarator, not the whole declaration statement.

These are syntax categories, not semantic identities. Parser-only wrappers, punctuation, comments, class fields, JSX/TSX and unlisted forms do not become extra categories. `ownBody` is not implemented.

### Navigate

`{kind:"navigate", relation:"parent"}` requires an exact named syntax node and skips parser-only wrappers. Exact parts and captures work; first use enclosing when a range cuts through a node. A whole-file seed is not implicitly split into functions.

- parent selects the nearest normalized ancestor, excluding the starting node.
- ancestors selects all normalized ancestors in source order.
- children selects nearest nested constructs; descendants selects all nested constructs.
- siblings selects other constructs with the same normalized parent. previous/next selects the immediate neighbor; all selects every sibling. Missing neighbors are valid absence.

An `object` filter is applied after navigation; it never changes topology. Parent with object:function does not jump past an intervening call. Children with object:call does not jump through an if. Use ancestors/descendants for deeper matches.

Ancestors and descendants can overlap. Narrow to disjoint targets before editing; edit tools reject overlapping writes.

### Named parts

`{kind:"part", part:"arguments"}` requires an exact construct. Parts keep their delimiters: block bodies include braces, argument/parameter lists include parentheses, annotations include colons, and else/finalizer clauses include their keywords. Expression arrow bodies are exact expressions.

| Construct       | Supported parts                                            |
| --------------- | ---------------------------------------------------------- |
| function        | name, parameters, returnType, body                         |
| call/new        | callee, arguments                                          |
| class           | name, body                                                 |
| if              | condition, then, else                                      |
| switch          | condition, body                                            |
| classic for     | initializer, condition, update, body                       |
| for-in / for-of | left, iterable, body                                       |
| while / do      | condition, body                                            |
| try             | body, handler, finalizer                                   |
| catch           | parameter, body                                            |
| finally clause  | body                                                       |
| binding         | name, type, value                                          |
| assignment      | left, right                                                |
| property        | key, value; shorthand selects the same identifier for both |
| return / throw  | value                                                      |

An absent optional part produces no selection. An unsupported part reports available names. Objects and arrays do not invent body or arguments parts.

```js
const found = await tools.search({ path: "client.ts", query: "ast:send($$$ARGS)" });
const call = await tools.select({ path: found, operation: { kind: "object", object: "call" } });
const args = await tools.select({ path: call, operation: { kind: "part", part: "arguments" } });
text(await tools.read({ path: args }));
const number = await tools.search({ path: args, query: "10" });
await tools.replace({ path: number, text: "20" });
```

### List element extents

`{kind:"elementExtent", extent:"inside"}` requires an exact direct call/new argument or parenthesized function parameter. Use a displayed Search capture reference for that element. Variadic captures can include punctuation; punctuation is not an element. Typed/default parameters must include their type/default.

Inside keeps the element. Around adds owned comma/whitespace and preserves list parentheses. First/middle elements own the following gap. A last element with a trailing comma owns that following gap; without one it owns the preceding gap. An only element owns the whole list interior.

Adjacent comments make around ambiguous; inside remains available. Several around extents may overlap, so do not assume bulk deletion repairs syntax. Copy/move transports exact selected bytes, not a refactoring. Destination syntax and parameter ordering remain the caller's responsibility. Arrays, objects, partial expressions, whole lists and unparenthesized arrow parameters are unsupported here.

## Text operations

- range: absolute startLine/startColumn/endLine/endColumn in one source; lines are one-based, columns UTF-16, end exclusive. Must fit one input region.
- lines: inclusive first/last complete source lines, including existing endings; must fit one region.
- between: pairs each non-empty start marker with the nearest following end, without nesting, then resumes after the pair. Extent inside excludes markers, around includes them, lines expands to containing lines. Unmatched openings are errors; no openings is valid absence.
- sliceText: relative UTF-16 from/to in each region; to is exclusive and defaults to its end. Equal offsets select a point.
- trim: removes whitespace from start/end/both edges. Whitespace-only input selects a point at its end.
- split: divides by a non-empty literal delimiter, excluding delimiters and retaining empty segments as points.
- linesOf: expands to complete containing lines. An exclusive end at next-line column zero does not include that line.
- position: before/after points of each region. Use a whole-file Read for file edges.
- columns: exclusive from/to columns on each touched line, excluding endings. Every interval must fit its line and input scope.

Except for range/lines, operations apply independently to each region. Sparse gaps stay separate. Markers cannot cross gaps. Bounds inside surrogate pairs or CRLF are errors; ranges are never silently clipped. Only linesOf and between/lines explicitly expand text input.

## Range sets

Pass candidates in `path` and comparison results in `operation.scopes`. Both accept unchanged results, issued references or arrays. Match by source and snapshot, not array order. Every input is verified, even without a counterpart.

- within retains a candidate only if one scope contains it; no clipping or joining for containment.
- intersection clips each candidate to the union of scopes.
- difference subtracts scopes and retains separate surviving fragments.
- merge joins overlapping candidates. adjacent:true also joins touching nonempty ranges, never real gaps.

Points belong to a nonempty range at its included start, not its excluded end. Equal points match. Intersection with a contained point keeps it; touching ranges do not create points. Difference removes covered candidate points but point scopes do not cut text. Merge absorbs covered points without extending ranges. EOF points are outside a range ending at EOF.

Empty scopes make within/intersection empty and difference unchanged. Incomplete inputs cannot establish absence or authorize edits. Select never writes or formats.

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

## Composition limits

Read may show whole-line context around a selection, but later tools remain within its exact selected ranges. Whole-file write/undo reject partial selections. Insert remains line-based. Changed files, new sessions and reloads retire IDs; final Codemode formatting may also retire earlier results.

A function body includes nested functions. To check a call in a function's own body, compare the call's nearest enclosing function with the original owner using their source-local selections. Syntax names alone do not establish semantic identity. Do not establish absence from incomplete results.
