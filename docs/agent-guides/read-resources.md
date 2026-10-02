# Read resources workflow

## Selecting a source

`path` selects a resource. Supported providers include regular files and directories, `file:` URLs, HTTP(S) URLs, PDFs, images, returned `temp:` references, `SEARCH#` references, and enabled protocol resources.

Common protocol resources include:

- `raw:<file>` — original bytes without decoding.
- `docs:` and `docs:<id>` — packaged agent guidance.
- `ast:<path>` — compact syntax outline.
- `symbol:<file>#<selector>` — one declaration.
- `graph:<file>` and `graph:<file>#<selector>` — declarations and relationships.
- `diagnostics:<path>` — lint and language-server findings.
- `process:<PID>` — process metadata.
- `window:<PID>` and `display:` — visual capture when enabled.
- `shell:<session>` — terminal state and retained output.
- `debug:<session>` — debugger state.

A source may also include a returned anchor, such as `notes.txt#12#A4F0`. A `SEARCH#` reference already identifies its source, so pass it directly as `path`.

## Windows and continuation

For text resources, `offset` is a one-based starting line and `limit` is the maximum number of lines. Zero starts at the first line; negative offsets count from the end. On an anchored path, offsets are relative to the containing source line. Follow returned continuation offsets or temporary references instead of repeating an oversized read.

For `raw:` resources, offsets and limits count bytes. A negative offset counts from the end and a zero limit reads no bytes. Raw resources do not accept text anchors or views.

Temporary resources remain available only in their owning runtime.

## Native Codemode data

Check `status` before reading `data`. Use text `data.lines` and their `anchors` without parsing display rows. Use source-level `data.references` for actions such as Git changes. Follow `data.continuation` as a complete next Read request; its offset is absolute on its returned source. Check `data.truncated` and `data.fullResult` when present.

Use `data.bytes` for `raw:` reads. Forward a native image from `data.blocks` with `image(block)`. Keep multi-source `data.resources` separate instead of joining unrelated ranges.

## Reusing source windows

Exact filesystem text reads expose `data.target`. Pass the successful result, its data, or that `RESULT#` reference as `search.path` or `replace.path` to reuse the requested window, not just its shortened preview. Read-only derived views, bytes, images, and directory listings do not gain text-edit authority.

Check that a target was returned before composing source operations. Obtain a fresh Read/Search after source bytes change, the session changes, or Pi reloads. New result targets never silently refresh.

## Views

Views request source-specific presentations without changing the selected resource. Common views include:

- `anchors` — editable `LINE#HASH` references.
- `ast` — syntax-scope boundaries.
- `changes` — staged and unstaged Git changes with `CHANGE#` anchors.
- `diagnostics` — findings beside source text.
- `breakpoints` — current debugger breakpoint locations.
- `image` — one visual frame or terminal screen.
- `sequence` — several ordered visual frames.

Combine views only when both presentations are needed. Read the smallest useful source window and treat unsupported source/view combinations as errors rather than silently substituting another resource.

For image grid selection, `limit` is the square cell size in output pixels and `offset` is the zero-based row-major cell number. `limit` without `offset` selects cell zero; `offset` without `limit` is invalid.
