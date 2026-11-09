# Exact text anchors

This plugin is the final text anchor fallback. A non-empty value that is not a structured anchor selects one unique text span in the current file.

```text
replace(path="src/store.ts", start="old call()", text="new call()")
```

Exact text may cover part of a line, one complete line, or several complete lines. Used alone, a match that covers complete lines selects those lines with their own terminators. An unterminated final line never selects the preceding separator. Partial-line matches remain exact character spans, including for insertion. LF text also matches the same CRLF source text. Copy and Move preserve the selected source text, including its line endings. New Replace and Insert payloads use the destination's line-ending style; unselected bytes, including the BOM, remain unchanged.

A start and end may use different anchor formats:

```text
replace(path="src/store.ts", start="function load() {", end="24#A4F0", text="replacement")
```

In a pair, exact-text endpoints keep the literal match boundaries, including any newlines supplied in the text. They do not expand to containing lines or include an unsupplied trailing line ending. The range starts at the left edge of `start` and ends at the right edge of `end`; a line-anchor endpoint keeps its complete line. The same rule applies to paired copy and move destination selectors.

Missing or ambiguous text never changes a file. Exact ambiguity returns every allowed exact candidate. Missing text may return conservative fuzzy candidates. Candidate context uses the active primary presenter, such as fresh `LINE#HASH` anchors, so the next call can use a stable structured anchor.

Fuzzy matching runs in a Worker with a hard search timeout. It is recovery only and can never apply a mutation. See [docs/configuration.md](/docs/configuration.md) for project settings.
