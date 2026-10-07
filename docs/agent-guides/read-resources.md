# Read results and selections

## Preserve source boundaries

A Read result retains the requested source window. When reading a selection, Read may display surrounding whole lines. That context does not widen the selection used by later tools.

Read-only views, bytes, images and directory listings do not grant text-edit authority. Read the original text source when you need an editable selection.

## Continue with another tool

Search a Read result to look only inside its selection. Use Select to derive new boundaries before editing.

Read `docs:select-code` for selection workflows and `docs:editing` for using results in mutations.

## Comparing text sources

When a Diff source resolves to several resources, their text is joined with one newline separator in resolver order. Diff line numbers refer to each compared text, not original source line numbers when a window is selected.
