# Exact text anchors

This plugin is the final text anchor fallback. A non-empty value that is not a structured anchor selects one unique text span in the current file.

```text
replace(path="src/store.ts", start="old call()", newText="new call()")
```

Exact text may cover part of a line, one complete line, or several complete lines. It always selects exactly its characters: a match that covers complete lines does not take their line breaks, so Insert adds text right at its boundary and Delete leaves the line break in place. Include the newline in the text to select it. How a literal meets invisible bytes, such as a BOM, CRLF line endings and special spaces, follows the [editing principles](/src/extensions/pi-agent-text-editor/docs/editing-principles.md): matching is tolerant, writing is strict. Copy and Move preserve the selected source text, including its line breaks. Replace and Insert write their text exactly as given; unselected bytes, including a BOM, remain unchanged.

A start and end may use different anchor formats:

```text
replace(path="src/store.ts", start="function load() {", end="K7M2QX4", newText="replacement")
```

In a pair, exact-text endpoints keep the literal match boundaries, including any newlines supplied in the text. They do not expand to containing lines or include an unsupplied trailing line ending. The range starts at the left edge of `start` and ends at the right edge of `end`; a line-anchor endpoint keeps its complete line. The same rule applies to paired copy and move destination selectors.

Missing or ambiguous text never changes a file. Exact ambiguity returns every allowed exact candidate. Missing text may return conservative fuzzy candidates. Candidate context uses the active primary presenter, such as fresh line anchors, so the next call can use a stable structured anchor.

Fuzzy matching runs in a Worker with a hard search timeout. It is recovery only and can never apply a mutation. See [docs/configuration.md](/docs/configuration.md) for project settings.
