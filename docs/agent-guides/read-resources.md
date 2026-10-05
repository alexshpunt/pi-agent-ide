# Read resources workflow

## Selecting a source

`path` selects a resource. Supported providers include regular files and directories, `file:` URLs, HTTP(S) URLs, PDFs, images, returned `temp:` references, `SEARCH#` and `RESULT#` references, and enabled protocol resources.

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

## Readable results and composition

Read returns the same file text or requested views in direct calls and Codemode. It adds a leading system-result envelope with a UUID. The envelope is an internal reference, not file content; do not edit or insert it into a file. Follow the displayed continuation offset or temp reference for more output. Raw reads show hexadecimal bytes. Nested image reads also deliver their images on the parent Codemode result.

Pass an unchanged result as `read.path`, `search.path`, `select.path` or a supported edit source parameter. Outside Codemode, its UUID works too. Store/load retains these strings within the session. Read results keep their requested source windows, not just the shortened preview. Read-only derived views, bytes, images and directory listings do not gain text-edit authority.

Read of a selected result may show surrounding whole-line context, but later tools remain restricted to its original exact selection. Context does not grant wider edit authority.

Changed snapshots permanently retire their old IDs, even if the file is restored later. Obtain a fresh Read/Search after changes, session switches or reloads. Unsupported and expired references are errors, not empty results.

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
