# Changelog

## 0.6.0 — 2026-09-16

### Agent vision

- Let agents discover running processes and read process metadata.
- Let agents inspect application windows, full displays, and rendered web pages as images. Agent-owned windows are available by default; arbitrary windows and full displays require separate opt-in settings.
- Add image sequences for observing changing interfaces and media over time.
- Let agents choose sequence duration, frame interval, image scale, normalized image regions, and grid cells.
- Add executable allowlists for desktop applications that agents may inspect without unrestricted window access.
- Support Linux and macOS capture through `node-screenshots`, plus visible Windows-host windows and displays from WSL.

### Apply

- Keep successful independent changes when another operation in the same transaction fails, and report the outcome of each operation.
- Add selection-set replacements, removals, copies, and moves for exact matches and structural-search results.
- Add whole-file create, copy, move, and delete operations to Apply scripts.
- Refresh open files after `flush()`, preserve line endings for line-based edits, and skip post-processing for files that were subsequently moved or deleted.

### Windows

- Add native Windows support for Agent IDE debugger workflows, filesystem identity, language detection, command launchers, and executable discovery.
- Improve debugger support across the Windows language toolchains that are available on the machine.

### Settings

- Add editable settings for sequence duration, frame interval, image scale, and allowed executable names.

## 0.5.1 — 2026-09-14

### Sessions and processes

- Keep active terminal and debugger resources alive across extension reloads, so agents can reconnect to the same `shell:` and `debug:` sessions.
- Add terminal input mode to the process panel. Press `i` in a terminal detail view to send text and keys, and press Escape to return to the normal view.
- Keep foreground terminal waits running in the background when an agent turn is interrupted instead of reporting them as aborted.
- Bound terminal-search output in the TUI while keeping the complete search result available to the agent.

### Reading and search

- Return a bounded hex and ASCII preview for unsupported HTTP binary responses instead of downloading the full body or failing without useful content.
- Preserve native image reads when a server reports a generic binary content type for a known image URL.
- Keep search results when a file or terminal log changes during the search. Stale results remain visible, but unsafe anchors are omitted.

## 0.5.0 — 2026-09-13

### Debugging

- Add agent-native debugger sessions backed by the Debug Adapter Protocol. Agents can launch programs, set and remove breakpoints, continue execution, step through code, inspect stopped source, and terminate sessions through addressable `debug:` resources.
- Add verified Linux adapters and project checks for JavaScript, TypeScript source maps, shell scripts, C, C++, Rust, Swift, Zig, Java, Kotlin, C#, Python, Go, Dart, PHP, Ruby, Lua, PowerShell, R, Julia, and Elixir.
- Bring terminal and debugger activity into one `/agent-ide-processes` panel with live state, elapsed time, source context, and session controls.
- Keep active debugger sessions attached across extension reloads, preserving their `debug:` resources and stopped state.

### Transactional Apply

- Replace full-file rewrites inside `apply` with a snapshot-guarded editor API. Scripts open immutable file snapshots, stage exact text and whole-file changes, and commit them together with an explicit `apply()` call.
- Validate every staged operation before writing. If a multi-file commit fails after writing starts, Apply attempts to restore the original files and reports whether rollback completed.
- Return a session-scoped `APPLY#` receipt to the agent after a successful commit. `undo` can use it once to restore every touched path together, refuses stale receipts before changing files, and reports any restore or compensating-rollback failure.
- Keep the undo receipt out of the user-facing Apply result. Undo itself uses a compact success or failure status with the number of restored files.
- Compact long Apply source previews to a useful head and tail, and render explicit `result()` values as first-class result blocks.

### Terminal reliability

- Replace the generic `run` tool with `bash` on Unix-like systems and `powershell` on Windows. Commands still run in the user’s configured system shell, whose syntax is included in the agent guidance.
- Preserve foreground commands when the agent turn times out or is interrupted. They continue as background sessions instead of being terminated, and interactive prompts return control without losing the process.
- Add configurable foreground wait timeouts and report process timeouts, signals, failures, and successful exits as soon as they happen.
- Wake an idle agent when a running background session produces no output for two minutes. Repeat the notice every two silent minutes until the session changes or finishes.
- Bound terminal output in both command results and `shell:` reads. Keep the useful tail in context and save the complete output to a readable log file.
- Keep process panels live while terminal and debugger sessions change state.
- Keep live terminal sessions attached across extension reloads with the same `shell:` resource and process.

### Reading, search, and language support

- Expand AST parsing and structural search across the supported language catalog, including native parsers for Go and other non-TypeScript languages.
- Apply syntax highlighting before AST scope and anchor annotations, so structural reads keep both code colours and stable line markers.
- Promote semantic code views in agent guidance: workspace symbols for discovery, file graphs for relationships, and declaration reads for focused implementation work.
- Compact large text-search results before they consume the agent context while preserving reusable search selections.

### File operations and hooks

- Unify whole-file and selected-text operations under `copy`, `move`, and `delete`. Supplying only source and target paths performs a whole-file operation; selectors continue to operate on text.
- Show whole-file copy, move, and delete results as compact success or failure cards without repeating paths already present in the header.
- Add project and global file hooks for reads and text edits. Extensions can deny reads, reject resolved text edits and file creation before their first write, or attach feedback after a saved text edit.
- Run before-edit hooks once against the complete set of staged text edits in an Apply commit. Whole-file copy, move, and delete operations remain outside the edit-hook contract.

## 0.4.0 — 2026-09-11

### Terminal sessions

- Add a cross-platform `run` tool for synchronous and background commands. It uses Bash on Linux, PowerShell on Windows, and the system shell on macOS, with platform-specific guidance for the agent.
- Keep every run as an addressable `shell:` resource. Agents can read its output, send text or key chords, search retained output, batch input through `apply`, stop it with `delete`, and request a terminal screenshot.
- Let agents choose the virtual terminal width and height for full-screen and interactive programs.
- Deliver background completion automatically and wake the agent. Short jobs produce one completed card; longer jobs keep an initial card and add one completion card when they finish.

### Terminal interface

- Show themed terminal cards with the shell, working directory, execution mode, command, output, elapsed time, and exit status without exposing internal session IDs.
- Stream a bounded initial preview for background runs, then keep later output available through terminal reads.
- Show compact text around the changed terminal region after input. Image-capable models also receive a cropped terminal image.
- Add a `/terminals` overlay for active and recent sessions, plus detailed, compact, and hidden activity modes.

### Settings

- Add the terminal as an independently configurable feature that is enabled by default.
- Rework Agent IDE settings into a bordered panel with separate Features, Behavior, and UI tabs.

## 0.3.0 — 2026-09-10

### Composable IDE tools

- Add `apply`, a JavaScript scratchpad for combining reads, searches, diffs, guarded text edits, whole-file operations, and Git change operations in one call. Calls run in order, return structured data, and keep completed changes when a later operation fails.
- Add standalone `diff`, `copy_file`, `move_file`, and `delete_file` tools. The same operations are available inside `apply`.
- Let `apply` reuse search selections, text anchors, AST matches, inherited sources, formatter hooks, and explicitly requested diagnostics from the existing IDE tools.
- Add safe symbol operations backed by language servers. Tools can resolve declarations and rename a symbol with native reference updates when the server supports it.
- Add `raw:` reads for inspecting original file bytes without text decoding or conversion.

### Editing and post-processing

- Keep formatter, linter, and language-server discovery local to the project that owns each edited file. Files outside the active project no longer inherit its toolchain.
- Preserve successful effects, explicit results, preview arguments, and recovery details across mixed `apply` scripts. Keep empty-file creation and formatted results visible and reusable.
- Run only explicitly requested diagnostics inline. Automatic post-edit checks remain asynchronous and no longer break otherwise successful reads or edits.
- Reuse resolved search and AST selections across guarded operations, including exact replacements and multi-file scripts.

### Interface and settings

- Add incremental previews for mixed `apply` scripts, with syntax-coloured calls, results, diffs, formatting status, and grouped diagnostic feedback.
- Add settings for enabling `apply`, choosing its preview style, and managing IDE modules and feature groups from named settings tabs.
- Show ordinary read windows as line ranges, while keeping anchor-relative reads and tail reads explicit.
- Show whole-file operation names as `copy file`, `move file`, and `delete file` in tool cards and results.
- Tighten compact spacing and keep explicit output visible when reads, edits, and Git operations share one preview.

## 0.2.2 — 2026-09-08

### Agent guidance

- Clarify tool descriptions and input parameters so agents can choose the right read, search, or edit operation. Keep tool-specific details with each tool and shared workflow rules in the system prompt.
- Explain how to reuse anchors, recover from broadened searches, and batch independent edits without retrying changes that already applied.

### Editing and search

- Fix ranges that mix exact text, line anchors, and search references. Explicit start and end anchors select inclusive whole lines; insert, copy, and move destinations use the containing line boundaries.
- Fix empty replacements of whole-line selections so they remove the lines instead of leaving a blank line.
- Preserve unselected line breaks when deleting exact search matches at the end of a file.
- Fix `files:` glob matching, including nested paths, basename patterns, character classes, and brace alternatives.
- Report applied edit counts and formatting outcomes. Group repeated replacements into a compact summary with every affected file, and rerun referenced searches to report remaining matches within their original scope.

### Reading

- Show a compact, source-numbered AST overview when a supported code file exceeds the read limit. Reduce detail until it fits, and keep ordinary truncation when no usable outline is available.
- Fix AST outline positions for CRLF text and characters such as emoji.
- Remove the standalone `lines` view. Use `anchors` for source line numbers with edit references.
- Preserve Pi's native read presentation for skills, agent context files, and Pi documentation when no extra views are requested.

### Interface and configuration

- Keep local diffs aligned after formatting shifts lines. Report changes outside the displayed area or changes that cannot be assigned to one edit instead of showing misleading hunks.
- Show formatting status alongside diffs and visible background diagnostic summaries with per-file counts and expandable provider details. Send automatic notifications only for actual findings; keep pending, unavailable, and empty reports out of both the chat and the agent's context.
- Add `noAnimations` and `noPostProcessing` settings, with matching `--pi-agent-ide-no-animations` and `--pi-agent-ide-no-post-processing` flags. These can disable edit animations or automatic post-edit checks and formatting while keeping explicit reads and requested edits available.
- Name the actual formatter, linter, or language-server executable in formatting results and diagnostic messages. Show diagnostic tool names beside their counts even when the entry is collapsed.
- Deliver new diagnostic findings immediately to the chat and agent. Late findings wake an idle agent without waiting for another user message; duplicate and empty reports stay silent.
- Load built-in extension entry modules only when selected, avoiding imports for disabled built-ins.

## 0.2.1 — 2026-09-07

### Stability and Windows

- Keep Pi running when a language server closes its transport during initialization, requests, or notifications. Failed LSP connections remain unavailable rather than appearing healthy.
- Resolve Windows executable suffixes and project-local command shims consistently, including paths with spaces and Python virtual environment `Scripts` directories.
- Stop treating every `package.json` as a request to install JSONLint. Doctor now uses JSONLint settings or an explicit dependency as evidence.

### Expanded language support

- Add and correct built-ins for Kotlin, Swift, Dart, PowerShell, Ruby, Lua, R, Scala, Elixir, Zig, Julia, frontend frameworks, and infrastructure formats.
- Match native basenames such as Dockerfile and CMakeLists.txt. Limit Angular language support to projects with its native root marker, and use the correct language IDs for JSX and TSX.
- Support language-server configuration and workspace-folder requests, file watchers, and requested save notifications. Preserve diagnostic versions when file content has not changed.
- Support project-relative paths in LSP initialization options, multiline diagnostic reports, zero-based tool columns, and diagnostics at the end of a file.
- Parse line-oriented diagnostics from both output streams, including JSONLint errors written to stderr.
- Installed tool versions and native project settings remain prerequisites; support does not imply every tool version or operating system has been verified.

### Native language toolchains

- Prefer native formatter and linter settings when choosing built-ins. Find project tools in Python virtual environments and Composer's `vendor/bin`, as well as `node_modules/.bin`.
- Report missing native tools through Doctor instead of silently choosing an unrelated formatter.
- Fix CSharpier detection and diagnostic commands or parsers for .NET, Go, PHP, HTML, CSS, and Java. Keep project-wide lint findings attached to the correct file.
- Treat a failed linter with no parsed findings as a failure, not a clean check.
- Use the language server's advertised diagnostic mode, fixing Java and Go servers that publish diagnostics without supporting pull requests.
- Verify native mini-projects with real formatting, lint, language diagnostics, and separate compiler or behavior checks before and after formatting.

## 0.2.0 — 2026-09-05

### Editing and search

- Edit with exact text or anchors, insert before or after a target, and use search results directly for reads and edits across files.
- Search tries literal text first, then regex and individual words when needed. Quoted text and Boolean conditions keep their meaning, and fallback steps are reported.

### Background diagnostics

- Lint and LSP checks run after edits are saved, without holding up the edit result. Agents receive a compact summary in their next model context and can request details through `diagnostics:` or the diagnostics view.
- Pending and unavailable checks are reported explicitly rather than appearing clean.

### Web reading

- URL reads automatically retry in a local browser when ordinary loading fails or a page needs JavaScript. If both attempts fail, the result includes both errors.

### Interface and performance

- More consistent tool output and steadier streamed diffs, with fixes for wrapping, backgrounds, and large edits.
- Smaller saved tool histories and startup that no longer waits for optional tips.

### Configuration and agent guidance

- Built-in formatter, linter, and LSP settings can be overridden globally or per project.
- Updated agent instructions explain the available tools, search references, and editing rules.
