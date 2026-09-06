# Changelog

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
