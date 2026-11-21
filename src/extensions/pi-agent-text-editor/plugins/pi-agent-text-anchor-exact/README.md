# Exact text anchors

This plugin is the final text anchor fallback. A non-empty value that is not a structured anchor selects one unique text span in the current file.

```text
replace(path="src/store.ts", at="old call()", text="new call()")
```

Exact text may cover part of a line, one complete line, or several complete lines. The selected span is exactly the matched characters: a match that covers complete lines does not take their line breaks, so Insert adds text right at its boundary and Delete leaves the line break in place. Include the newline in the text to select it. How a literal meets invisible bytes, such as a BOM, CRLF line endings and special spaces, follows the [editing principles](/src/extensions/pi-agent-text-editor/docs/editing-principles.md): matching is tolerant, writing is strict. Copy and Move preserve the selected source text, including its line breaks. Replace and Insert write line breaks in their text with the line ending of the line where the matched span starts, as Pi's edit does; unselected bytes, including a BOM, remain unchanged.

Two endpoints may use different anchor formats:

```text
replace(path="src/store.ts", from="function load() {", through="K7M2QX4", text="replacement")
```

In a pair, exact-text endpoints keep the literal match boundaries, including any newlines supplied in the text. They do not expand to containing lines or include an unsupplied trailing line ending. With `from` and `through`, the range starts at the left edge of the opening match and includes both matches in full, even when the closing match starts inside the opening match. A line-anchor endpoint marks its line's content boundary when paired with exact text. The same rule applies to paired copy and move destination selectors.

Missing or ambiguous text never changes a file. The error can show candidates with fresh anchors for selecting one match. For missing text, these can be conservative fuzzy candidates. An ambiguous literal can also return a `SEARCH#…:all:match` selector for [editing every non-overlapping match](/src/extensions/pi-agent-text-editor/docs/editing-principles.md#3-tolerant-matching-strict-writing).

The fuzzy candidate search runs in a Worker with a hard search timeout. It is recovery only: it returns candidates and can never apply a mutation. The tolerant matching that follows Pi's edit, which ignores a BOM, matches any line ending and normalizes quotes, dashes and special spaces, is a separate step of the literal match itself and can select the span. See [docs/configuration.md](/docs/configuration.md) for project settings.
