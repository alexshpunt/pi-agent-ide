# Changelog

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
