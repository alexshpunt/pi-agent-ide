# Changelog

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
