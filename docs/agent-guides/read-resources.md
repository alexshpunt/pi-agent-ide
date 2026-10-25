# Read results and selections

## Preserve source boundaries

A Read result retains the requested source window. When reading a selection, Read may display surrounding whole lines. That context does not widen the selection used by later tools.

Read-only views, bytes, images and directory listings do not grant text-edit authority. Read the original text source when you need an editable selection.

## Handle failed Reads

In Codemode, a completed failed Read resolves to `{ status: "error", errors }`. Inspect `errors` before composing another tool call. An error value is not an empty success and grants no source or edit authority.

Blocked calls and pending-edit commit failures can still reject. Handle those exceptions as well as returned Read errors.

## Continue with another tool

Search a Read result to look only inside its selection. Narrow it with a regex, or with `ast_search` for syntax, before editing.

Read `docs:search-code` for narrowing workflows and `docs:editing` for using results in mutations.

## Comparing text sources

When a Diff source resolves to several resources, their text is joined with one newline separator in resolver order. Diff line numbers refer to each compared text, not original source line numbers when a window is selected.
