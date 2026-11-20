# Editing principles

These principles are the design of editing in `pi-agent-text-editor`. Read them before changing how a tool selects text, how a literal is matched, or what an editing error says. They apply to `replace`, `insert`, `delete`, `copy` and `move`, and to the edit prompts and results that present them.

## 1. An exact edit that any model can express

The goal is an exact, byte-for-byte edit that any model, including a weaker one, can express. The model sees text and passes it as well as it can. The tools find what it meant and change exactly that.

The model is not asked to reproduce what it cannot see or copy reliably. Guidance asks for unique exact text. It never pushes the model towards the shortest or most minimal literal: a literal cut right at the end of the visible text sits next to invisible bytes.

## 2. Raw text has a structure nobody sees

Raw text carries bytes that neither the model nor most readers see: a BOM, CRLF line endings, special spaces such as a non-breaking space, and a final line break or the lack of one. The tools account for this structure. The model does not have to reproduce it to hit the right place.

## 3. Tolerant matching, strict writing

Matching and writing follow different rules.

- Match the literal against file text first: exact, then normalized, then fuzzy. Only then try the current Read `anchors` view. A copied `HASH|text` fragment may start or end partway through a line; the hashes must still match, and only source characters are selected. A copied final no-newline marker is display-only and selects no bytes.
- Writing is strict. Everything outside the edited span stays byte for byte, including a BOM, line endings and the final line break. Principle 4 gives the rules.
- An ambiguous match is refused. The tools never pick between candidates; the error lists them so the next call can select one.

A match never decides what the tool writes outside the span it selected.

## 4. Selectors only locate; one algorithm writes

Every edit inside a file goes through one write algorithm, whatever selected its place: exact text, a line anchor, a SEARCH# `:line` or `:match` reference, a line range, an LSP declaration or reference, an AST match, or a Read or Search result. A selector only resolves a span: a range of characters, or whole lines. It never decides how the text is written. The algorithm follows the rules of an edit by exact text, as Pi's edit writes `newText`:

- Line breaks in the written text take the line ending of the line where the span starts. An insertion takes the line ending at the insertion point.
- The BOM belongs to no line. No selector captures or removes it; only a whole-file `write` replaces it.
- Over whole lines, the text replaces the content of the lines. The last line keeps its own ending: CRLF, LF, or none at the end of the file, whether or not the text ends with a line break. Joining a line with the next one therefore needs an exact-text selector.
- Deleting whole lines removes them with their line endings and leaves no empty line. When the last deleted line has no ending, the line ending before it goes instead: deleting line 2 of `a⏎b` leaves `a`.
- Inserting lines adds the separators they need. After the last line of a file that ends with a line break, the file still ends with one: inserting `added` after line 1 of `base⏎` gives `base⏎added⏎`. Inserting lines and deleting them again restores the original bytes.
- A range with a line endpoint and an exact-text endpoint is a character span. The line endpoint marks the content boundary of its line: the start after a BOM, the end before the line ending. Deleting from `START` through line 3 of `left START right⏎middle⏎left END right⏎last` gives `left ⏎last`.
- Copy and Move keep the copied bytes, including their line endings. The same rules decide the target span, the BOM, the last line's ending, and the separators added at the target, which take the target's line ending.

The algorithm also keeps look-alike bytes. When the text a model sends for a span differs from the original span, outside the part it really changes, only by characters that Pi's `normalizeForFuzzyMatch` treats as equal (special spaces such as a non-breaking space, smart quotes, Unicode dashes, and the other equivalences literal selectors already use), those places keep the original bytes. A model that retypes a line from an anchor cannot see an invisible non-breaking space; the tools keep it. The sent text is aligned with the original character by character under the equivalence, and only aligned characters keep the original. Two cases write the text as sent:

- The whole replacement is equal to the original under the equivalence. The model's only change is the look-alike characters themselves, so a deliberate normalization such as a non-breaking space to a plain space works.
- The text differs from the original by more than a few edits. It is a rewrite, not a retyped copy.

Copied bytes (Copy and Move) and insertions have no original to align with and are written as they are. A replacement that is byte-identical to the selection is still refused.

Add no rule for one kind of selector. A case that a selector needs is a case of the write algorithm.

## 5. Every error tells the next step

An edit error says what did not match, what is similar, and which anchors to use. The recovery takes one turn: the next call can use a stable anchor from the error without reading the file again. An error that only reports failure is incomplete.

## 6. General rules, measured

Add a general rule, not a fix for one corner case. A new heuristic must hold across the cases the benchmarks cover, and each one is measured on:

- the byte-exact edit benchmark ([`benchmarks/byte-exact-edit`](/benchmarks/byte-exact-edit/README.md)), which compares the final file byte for byte with the expected file;
- the classic Explicit Edit suite.

A heuristic that helps one case and costs another is not added.

## Parameter names

`replace` and `insert` take the text they write in `text`. `write` takes the whole file in `content`. Terminal and debugger actions share the `insert` tool, so they pass their keys or command in `text` as well.
