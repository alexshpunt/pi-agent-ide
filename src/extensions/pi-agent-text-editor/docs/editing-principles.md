# Editing principles

These principles are the design of editing in `pi-agent-text-editor`. Read them before changing how a tool selects text, how a literal is matched, or what an editing error says. They apply to `replace`, `insert`, `delete`, `copy` and `move`, and to the edit prompts and results that present them.

## 1. An exact edit that any model can express

The goal is an exact, byte-for-byte edit that any model, including a weaker one, can express. The model sees text and passes it as well as it can. The tools find what it meant and change exactly that.

The model is not asked to reproduce what it cannot see or copy reliably. Guidance asks for unique exact text. It never pushes the model towards the shortest or most minimal literal: a literal cut right at the end of the visible text sits next to invisible bytes.

## 2. Raw text has a structure nobody sees

Raw text carries bytes that neither the model nor most readers see: a BOM, CRLF line endings, special spaces such as a non-breaking space, and a final line break or the lack of one. The tools account for this structure. The model does not have to reproduce it to hit the right place.

## 3. Tolerant matching, strict writing

Matching and writing follow different rules.

- Matching uses general heuristics: exact, then normalized, then fuzzy, and the anchored view of the file. A literal that names the intended span selects it even when invisible bytes differ.
- Writing is strict. Everything outside the edited span stays byte for byte, including a BOM, line endings and the final line break. The new text is saved exactly as sent.
- An ambiguous match is refused. The tools never pick between candidates; the error lists them so the next call can select one.

A match never decides what the tool writes outside the span it selected.

## 4. Every error tells the next step

An edit error says what did not match, what is similar, and which anchors to use. The recovery takes one turn: the next call can use a stable anchor from the error without reading the file again. An error that only reports failure is incomplete.

## 5. General rules, measured

Add a general rule, not a fix for one corner case. A new heuristic must hold across the cases the benchmarks cover, and each one is measured on:

- the byte-exact edit benchmark ([`benchmarks/byte-exact-edit`](/benchmarks/byte-exact-edit/README.md)), which compares the final file byte for byte with the expected file;
- the classic Explicit Edit suite.

A heuristic that helps one case and costs another is not added.

## Parameter names

`replace` and `insert` take the text they write in `newText`: it is new text, and `text` names too many other things. `write` takes the whole file in `content`. The `text` input of a terminal or debugger action is not a file edit; those actions share the `insert` tool, so they pass their keys or command in `newText` as well.
