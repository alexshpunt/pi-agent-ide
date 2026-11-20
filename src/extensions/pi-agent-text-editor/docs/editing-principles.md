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
- An ambiguous match is refused. Use a candidate anchor to select one match. If the error offers a `SEARCH#…:all:match` reference, pass it as `start` for Replace or Delete without `end`, or as `anchor` for Insert, to edit all non-overlapping matches from the original selection.

Matching locates the span. The write algorithm decides which line separators belong to a whole-line edit.

## 4. Selectors only locate; one algorithm writes

Every edit inside a file goes through one write algorithm, whatever selected its place: exact text, a line anchor, a SEARCH# `:line` or `:match` reference, a line range, an LSP declaration or reference, an AST match, or a Read or Search result. A span covers whole lines if it starts at a line start (after the BOM on line 1) and ends just before or just after the last line's ending. Other spans edit only their characters. The selector only locates the span.

- Line breaks in the written text take the line ending of the line where the span starts. An insertion takes the line ending at the insertion point.
- The BOM belongs to no line. No selector captures or removes it; only a whole-file `write` replaces it. A file keeps exactly the BOM it had, so a leading U+FEFF in text written at the start of a BOM file's content, by any selector or by an insert at the file start, is dropped. A file without a BOM takes the text as sent.
- A nonempty `replace` over whole lines keeps the last selected line's ending: CRLF, LF, or none at EOF. One trailing break in the supplied text marks the end of its last line; extra breaks add empty lines. Over line `b` in `a\nb\nc\n`, text `\n` gives `a\n\nc\n` and text `\n\n` gives `a\n\n\nc\n`. In CRLF text the empty lines use CRLF. At an unterminated end, replacing `b` in `a\nb` with `\n` gives `a\n`: the empty replacement line has no ending.
- `delete` and `replace` with empty text remove whole lines and leave no empty line. They remove the selected lines' endings. When the last deleted line has no ending, they remove the ending before the span instead: deleting `b` in `a\nb` leaves `a`.
- Text with no line break and default separation goes at the selected boundary. At a line edge, text with a line break lands as separate lines: the first break at each edge of the block is a separator, and further breaks add empty lines. For example, insert `\nadded\n` after `base` in `base\nnext\n` to get `base\nadded\nnext\n`.
- Text made only of line breaks inserts one empty line per break. At a line edge, `separation: "blank-line"` adds a blank line beside neighboring text where neither the file nor the extra breaks in the payload already provide one. Mid-line insertion keeps character semantics.
- With mixed line and exact-text endpoints, a line endpoint marks its line's content boundary: the start after a BOM, or the end before the line ending. Classify the resulting span by the same rule. Deleting from `START` through line 3 of `left START right\nmiddle\nleft END right\nlast` gives `left \nlast`.
- Copy and Move land whole lines separately at a line edge or over a whole-line target. A zero-width target is an insertion point. A mid-line insertion or a replacement over a partial target keeps character semantics: copying the line `block` over `SLOT` in `left SLOT right` gives `left block right`. Line breaks inside the copied text stay as they were; added separators take the target's line ending.
- A file without a final line break shows `\ No newline at end of file` after its last line, in Read and in mutation results. The marker is display only: it has no anchor or number, selectors ignore it, and `replace` and `insert` refuse text whose last line is exactly the marker, with `END_OF_FILE_MARKER`, so it never reaches the file.

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
