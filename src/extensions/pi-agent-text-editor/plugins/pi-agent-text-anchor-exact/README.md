# Exact text anchors

This plugin is the final text anchor fallback. A non-empty value that is not a structured anchor selects one unique text span in the current file.

```text
replace(path="src/store.ts", start="old call()", text="new call()")
```

Exact text may cover part of a line, one complete line, or several complete lines. A match that covers complete lines behaves linewise, so delete and move do not leave empty gaps and copy, move, and insert keep line boundaries. Partial-line matches remain exact character spans. LF text also matches the same CRLF source text. The edit keeps the file's BOM and line ending style.

A start and end may use different anchor formats:

```text
replace(path="src/store.ts", start="function load() {", end="24#A4F0", text="replacement")
```

The range starts at the left edge of `start` and ends at the right edge of `end`.

Missing or ambiguous text never changes a file. Exact ambiguity returns every allowed exact candidate. Missing text may return conservative fuzzy candidates. Candidate context uses the active primary presenter, such as fresh `LINE#HASH` anchors, so the next call can use a stable structured anchor.

Fuzzy matching runs in a Worker with a hard search timeout. It is recovery only and can never apply a mutation. See [docs/configuration.md](/docs/configuration.md) for project settings.
