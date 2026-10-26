# Syntax search with ast_search

`ast_search` runs ast-grep in files or inside a Read, Search or edit result. It works for every language ast-grep supports.

## Patterns

Pass `pattern` in source-code syntax. `$NAME` captures one node and `$$$ARGS` captures several, including their punctuation. A pattern must parse as code in the file's language.

Each match shows a `SEARCH#...:N:match` reference and a `capture NAME: RESULT#...` reference per capture. Pass either to Read, Search or an edit tool; a capture selects exactly its nodes, such as a function body or an argument list. `SEARCH#...:all:match` selects every match of a complete result. A single-match reference goes stale when its file changes; repeat the search.

```js
const calls = await tools.ast_search({ path: "client.ts", pattern: "request($OPTIONS)" });
text(calls.result);
```

## Rules

Pass `rule` with `language` for relations a pattern cannot express. `rule` is the value of `rule:` in an ast-grep rule file, as a JSON object: `pattern`, `kind`, `regex`, `inside`, `has`, `not`, `all`, `any`, `follows`, `precedes`. A relational rule needs `stopBy: "end"` to look past the nearest parent or child, and `stopBy: { kind: ... }` to stop at a boundary.

Calls to `send` in the own body of `outer`, skipping nested functions:

```json
{
  "language": "python",
  "rule": {
    "pattern": "send($$$)",
    "inside": {
      "kind": "function_definition",
      "stopBy": { "kind": "function_definition" },
      "has": { "field": "name", "regex": "^outer$" }
    }
  }
}
```

Node kinds are tree-sitter names and differ by language, for example `function_declaration`, `method_definition` and `arrow_function` in TypeScript, `function_definition` in Python. An unknown kind fails with an explicit error.

## Enclosing constructs

Pass a Read, Search or edit result as `path` and `relation: "enclosing"` to get the innermost match that contains each of its ranges. Starting from a text match:

```js
const hit = await tools.search({ path: "src/app.ts", query: '"connection lost"' });
const fn = await tools.ast_search({
  path: hit.result,
  relation: "enclosing",
  language: "typescript",
  rule: {
    any: [
      { kind: "function_declaration" },
      { kind: "method_definition" },
      { kind: "arrow_function" },
    ],
  },
});
```

Without `relation`, a result scope keeps only matches wholly inside its ranges; matches are never clipped.
