# Changelog

## Unreleased

### SSH workspaces

- Add configured Linux SSH targets to the existing IDE tools through `ssh://target/path`. Use project settings by default and global settings only when requested. Keep authentication and host-key trust in OpenSSH; unused targets open no startup connections.
- Read remote files, directories and raw byte ranges. Search remote text, file paths and AST patterns with the target's installed tools. Keep returned anchors and source selections usable across follow-up calls and native Codemode.
- Edit remote files with snapshot checks and text undo. Copy and Move files, directories and symlinks between local and remote locations or between configured targets. Apply deletion and transfer guards on the machine that owns each path.
- Run Bash with a remote `cwd` and a real PTY. Keep shell output, interactive input, screen reads and completion notifications available through ordinary `shell:` resources.
- Run language servers, linters and formatters on the selected target using its project settings and installed tools. Keep diagnostic paths, symbol navigation and semantic rename tied to that target.
- Read remote Git changes and use Stage, Unstage and Undo against the target's worktree and index.
- Launch target-owned debugger sessions with an SSH `cwd`. Keep source paths and breakpoint locations remote, and require the selected adapter on that target.
- Add remote process discovery and metadata, native Linux window/display capture, and explicit `web:ssh://target/https://...` reads and browser captures. Missing target facilities fail without a local fallback; ordinary web URLs still run locally.
- Let `/pi-agent-ide-doctor ssh://target/path` inspect and configure an explicitly selected remote project. Add `docs:ssh` setup guidance before any target exists and direct agents to read it when asked to work over SSH.

### Remote safety and cleanup

- Keep file selections, diagnostics, Git operations and process identities separated by target. Reject unknown targets and unsupported source combinations instead of silently using local files or tools.
- Resolve temporary-deletion settings from the remote account and project. Local settings do not grant remote deletion permission; protected paths, tracked contents and hooks remain guarded.
- Clean up only processes owned by each SSH command channel, including descendants that start new sessions. Report interrupted operations and uncertain cleanup honestly rather than claiming rollback or successful termination.

### Verification and known limits

- Add SSH integration coverage for tool composition, transfers, Git, language tools, debugger sessions, process cleanup, web reads and capture. Run namespace-sensitive cases in a separate unprivileged SSH job.
- Split core Linux integration checks into four CI jobs with separate logs and reports, and combine their results for the required validation gate.
- Document a known Java/Kotlin adapter issue: `fwcd/kotlin-debug-adapter` 0.4.4 can run past verified breakpoints. The issue was reproduced locally and over SSH; those recipes remain available, but a verified breakpoint does not guarantee a stop.

## 0.7.3 — 2026-10-09

### Directories and symlinks

- Let Delete remove directories recursively and unlink symlinks, including broken links, without following their targets. Protect project roots, ancestors and Git control paths; require host approval for tracked/staged and external targets. Refusal or an unavailable dialog prevents removal.
- Add `connectBeforeDeleteHook` for whole-object deletion and directory/symlink Move removal. A denied or failed hook blocks the operation; allowing never bypasses built-in protection.
- Let Copy merge a directory into the exact target path while keeping destination-only entries. Let Move replace the exact target directory. Both preserve file bytes, empty directories and symlink text, and reject aliases, overlapping trees, symlink destinations and type conflicts before writing.
- Allow configurable temporary roots for directory/symlink Delete. Defaults cover project and home temporary directories and the system temporary directory. Global and project settings can extend or replace them. Eligible descendants skip external/non-Git confirmation, but hooks, protected paths, tracked/staged contents and failed Git checks remain guarded.
- Report recursive filesystem failures after dispatch as unknown effects. Recursive operations have no rollback; inspect source and target before retrying.

### Editing and tool composition

- Return compact file Write receipts instead of repeating file content, diffs and diagnostics in model context. Keep full user-facing panels and whole-file follow-up selections; terminal input keeps its own receipt.
- Preserve per-resource Move rollback evidence. Distinguish restored resources from failed or uncertain restoration in agent results and user-facing diffs.
- Accept empty Move selections and paired zero-width points as no-ops without writing. Paired points select only the unchanged destination.
- Delete declarations through direct `symbol:` paths. Route `symbol:<file>#<selector>#name` replacement through semantic rename in native Codemode rather than declaration-text replacement.
- Keep original source selections behind compact AST Read overviews. Follow-up tools use the requested source range, not the displayed outline.

### Display and verification

- Explain shortened arguments, omitted result displays, omitted call panels and unavailable results separately in saved nested IDE displays.
- Hide internal result references from Stage's user-facing output and retain breakpoint-removal labels after deletion.
- Add an opt-in real-model capability matrix for direct and native Codemode routes. Free coverage checks do not call models or prove model execution; paid runs retain their evidence.
- Reuse recent full CI evidence only for identical trees and verification conditions. Promotion and versioned candidates still run their required full checks.
- Permit Bubblewrap user namespaces through a per-binary AppArmor profile on restricted Ubuntu CI runners. Keep the runner-wide restriction enabled and require a real sandbox launch before unit checks.
- Keep links to excluded tests and benchmarks usable in the public npm package by linking to the public repository.
- Update integration checks for compact Write receipts while retaining saved-byte, formatting, hook, output-recovery and native-panel contracts. Run sandbox semantic rename with the pinned Pi host and CI language-server toolchain.
- Reduce shared-runner integration concurrency to three processes to keep Pi startup within existing run limits and the complete suite within the unchanged job budget. Retain native Codemode failure traces.

## 0.7.2 — 2026-10-08

### Bounded output without losing the full result

- Apply a shared 50 KiB / 2,000-line useful-text budget to every IDE tool, including nested Codemode calls, blocked calls and argument-validation errors. Internal references and tool guidance remain separate from this budget.
- Preserve native text blocks in small Codemode results, so JSON output remains independently readable instead of being merged into the execution summary.
- Save complete text before budget truncation in private temporary files. Read the omitted tail by line, or use `raw:` byte windows for a single oversized line. Saved output stays available until its owning runtime is disposed.
- Make Search's `limit` count compact file summaries as well as detailed matches. Large searches no longer return thousands of file summaries despite a small limit; totals and omitted counts remain accurate.
- Bound image output across the whole result, including images forwarded by Codemode: at most 20 frames, 4 million pixels and 20 MiB of encoded image data. Resize oversized images and report omitted frames.
- Keep complete source selections and edit effects behind bounded previews. Truncating a display does not shorten a later Read, Select, comparison or mutation input.

### Editing and composition

- Make Write save the file and finish post-edit processing before returning, even inside Codemode. Its result selects the complete saved file for the next tool. Writing identical content leaves the file untouched and does not rerun post-edit handlers.
- Keep terminal result references usable after sending text or keys. Live terminal actions no longer trigger filesystem-target warnings or appear as saved files with internal command markers in Codemode results.
- Preserve Copy's destination selections through batched edits and formatting. Report unchanged destinations as no-ops rather than successful writes, and explain when a confirmed follow-up target is unavailable.
- Distinguish edits that were not applied, writes that remain applied after post-edit failure, successful rollback and failed or uncertain restoration. Keep those outcomes visible in both agent results and nested tool panels instead of implying that an error always means nothing changed.
- Remove the `flush` tool. Native Codemode completion and dependent source-tool calls commit pending edit batches; no explicit flush call is needed.

### Reading, search and tool guidance

- Explain empty sources, `limit=0` and offsets past the end separately. Read continuation hints identify the source and retain the requested views; raw reads state when their output was limited.
- Return clearer source errors and cancellation messages. Unsupported views and content explain what to change instead of silently implying a successful conversion. Unsupported web binaries are identified as metadata and byte previews, not document text.
- Mark incomplete Search coverage explicitly, so an incomplete result cannot be mistaken for proof of absence or used as an edit scope. AST overflow results also explain how to narrow the request.
- Clarify exact selections, comparison windows, source references, Git change anchors and shell-specific command syntax. Stage failures now explain stale anchors and possible index changes before a retry; Undo declares its required change selector in the tool schema.

### Debugger and model compatibility

- Refresh debugger state when delayed stop or exit events arrive. Track adapter-relocated breakpoints and later binding changes, and refresh displayed local variables after evaluation.
- Preserve omitted optional IDE tool arguments on Copilot's Responses route instead of letting implicit strictness turn them into required fields. Explicit strictness and other tools remain unchanged.

### Verification and maintenance

- Add real-Pi stress coverage for every callable IDE tool, direct and nested output, provider text and images, limit/view/offset/scope combinations and complete saved-output recovery. Include the reported Search case of 10,114 matches across 1,725 files with `limit=80`.
- Keep real debugger checks running in separate, non-blocking jobs with their own reports, outside shared CI totals. Pure debugger unit tests and editor checks, including Delete, still block the release.
- Automatically import newly opened GitHub issues into Linear, with stable issue IDs to avoid duplicate imports.

## 0.7.1 — 2026-10-05

- Reduced prompt size by keeping internal result structures out of agent-facing tool schemas.
- Restored readable string results for agents. Structured records stay internal because exposing their layout made tool use more complicated.
- Preserved tool composition, including Read, Search, Select, editing and Codemode store/load. Results carry registered references instead of exposing internal fields.
- Made Copy and Move replace existing destination files without a separate overwrite flag.

## 0.7.0 — 2026-10-05

### Native tool composition

- Compose Read, Search, Select and editing tools through source-backed results and exact snapshot targets, including sparse and multi-file selections. Reject stale or incomplete inputs without widening their scope.
- Search within returned Read and mutation targets. Keep mutation change records and destination targets available for follow-up work, with explicit reasons when a text target cannot be returned.
- Expose AST captures as source targets and LSP symbol identity and definition/reference roles. Follow references outside a seed scope only when explicitly requested.
- Remove Apply, its grouped undo receipts and preview settings. Use ordinary tools through native Codemode; per-file text undo and Git change undo remain. Native copy/move pairs selections rather than concatenating and broadcasting them.
- Fix empty-file creation so successful native writes report truthful applied effects and return usable targets.

### Select

- Add guarded text boundaries, marker pairs, slices, trimming, splitting, line expansion and exact insertion positions, preserving UTF-16 and CRLF boundaries.
- Add source-local range operations: containment, intersection, subtraction and explicit merging, without filling gaps between selections.
- Add JavaScript and TypeScript AST enclosing constructs, navigation and named parts. Select call arguments and function parameters with owned separators; refuse ambiguous neighboring comments instead of guessing or repairing syntax.

### Search and presentation

- Suggest bounded possible identifier names after eligible zero-result searches, with separate exact candidate scopes. Keep quoted, Boolean and explicit-protocol queries exact.
- Unify structural and text search panels and keep agent guidance out of fuzzy user cards.
- Skip LSP providers that do not support workspace symbols instead of sending unsupported requests.

### Mutation diffs

- Keep whole replacements visible when old and new blocks share no trimmed line. Avoid unnecessary character refinement while preserving the existing time, pairing and size limits, precise small-edit highlights and truthful unavailable state for unfinished comparisons.

### Packaging

- Fix a documentation link to excluded tests so public package validation succeeds.

### Verification

- Run the full integration suite in four standalone CI shards with separate reports and retained logs, without raising timeouts or skipping tests. Close each scenario's Pi process instead of accumulating shared fixture hosts.
- Check that each final file is formatted once without requiring independent files to finish in a fixed order.
- Make the shell-result scenario independent of background completion timing while keeping separate completion-delivery coverage.
- Run Windows source and installed-package checks without a retained shared harness workspace, avoiding locks on the shared cleanup directory.
- Retry transient Windows test-workspace removal locks a bounded number of times after the Pi process tree exits; persistent locks still fail. Retain Windows host traces on failure without changing test timeouts or assertions.

## 0.6.4 — 2026-10-03

### Native Pi integration

- Support Pi 0.99.1 and newer hosts with native tool namespaces, discovery, and Codemode execution.
- Keep the built-in edit placeholder hidden from declarations, discovery, and nested calls.
- Return structured IDE and shell results with explicit success, error, and partial outcomes.
- Batch sequential Codemode text edits against shared snapshots and expose committed results through `flush()`.
- Run disjoint Read, Search, and editing operations concurrently while preserving ordering and rollback protection for shared resources.
- Attach first-use guides without blocking or replaying tool calls, and preserve guidance across nested calls and session navigation.
- Keep IDE panels visible for nested calls, show final batch diffs without duplicate bookkeeping panels, and preserve bounded history and native usage accounting.
- Verify IDE tool coexistence with native MCP tools and resources.

### Packaging

- Fix Windows release entrypoint resolution, npm packing, and archive extraction.

### Editing and reading

- Suggest up to three nearby workspace paths when a local file is missing, without reading another file automatically.
- Preserve neighboring blank separators when exact-text anchors already include a newline.
- Bound large committed Apply results before serialization and keep full results addressable.
- Preserve structured source data when AST output exceeds the preview budget.
- Run independent post-read handlers concurrently while applying their transforms in order.
- Document and verify jq views for JSONL inspection.

### Search and presentation

- Search converted HTTP pages by URL, including regular-expression queries.
- Execute Boolean search without unsupported generated lookaround expressions.
- Keep Search footers within narrow terminals, including 40-column layouts.
- Refresh diff caches after native theme palette changes and preserve panel backgrounds and keyboard focus.
- Show precise character-level edit highlights and bound diff comparisons; report unavailable totals when comparison limits are reached.
- Keep known added and removed lines visible when detailed pairing reaches its limit, and avoid repeated short-string similarity work.
- Remove the redundant Git preview channel.

### Terminal

- Release foreground terminal waits as soon as Pi accepts user steering. Keep the same command running in the background with retained output and normal completion notifications; follow-up messages keep their existing wait behavior.
- Send one stale reminder per terminal session, including across reloads, while keeping completion notifications.
- Expose the actual shell, executable, and command syntax to agents, including PowerShell guidance on Windows.

### Optional code review

- Add opt-in background Jev review of saved diff fragments against user-defined YAML rules, without blocking edits or replacing diagnostics.
- Ship a separately enabled rule-capture skill that proposes reusable review rules and waits for confirmation before saving them. Both features are off by default.

### Debugging

- Fix the Java debugger lifecycle on Linux and native Windows with a dedicated java-debug/JDT LS backend. Start owned JVM targets suspended so the first breakpoint is not missed, and preserve source, locals, continue, and termination handling.
- Route deletion of terminated debugger sessions and breakpoints through the debugger resource handler.
- Bound replayable DAP events so noisy debug targets do not grow the queue without limit.
- Check each debugger's own executable or configured adapter path instead of applying Python or JavaScript probes to unrelated adapters.

### Verification

- Temporarily skip the flaky Windows Java public-Pi startup test. Keep Linux public-Pi and native Windows Java lifecycle checks enabled.
- Retain unit test reports immediately and stop before integration tests when the unit suite fails. Keep content checks independent of wall-clock load and allow independent formatters to finish in either order.

## 0.6.3 — 2026-09-27

### Editing

- Keep explicitly supplied trailing newlines when appending after an unfinished final line, and reject empty inserts without changing the file.
- Add optional blank-line separation for standalone insert and linewise Apply so separate blocks do not join neighboring paragraphs.

## 0.6.2 — 2026-09-18

### Debugging and terminals

- Let agents evaluate expressions in the selected stopped debugger frame and show the result directly in the debugger UI.
- Add timed image sequences for live terminal resources, including configurable duration, frame interval, and scale.

### Search and vision

- Render structural AST search results with the same grouped files, match highlighting, context, and compact expansion behavior as ordinary text search, while preserving exact `SEARCH#` references for agents.
- Route Agent IDE-owned Linux application windows through native Linux capture under WSL instead of treating their PIDs as Windows-host processes.

## 0.6.1 — 2026-09-17

### Progressive guidance

- Add addressable `docs:` resources for focused debugger, diagnostics, editing, Git, JSON, reading, search, terminal, and vision guidance.
- Stop the first matching tool call before execution, return its complete guide, and let the agent retry with the required instructions in context. Explicitly reading the guide first skips this gate.
- Keep shell commands for execution and direct agents to guarded editing tools instead of shell-based file edits.

### JSON reading

- Add parameterized `jq:` views for filtering and transforming filesystem JSON with the real `jq` executable.
- Apply normal Read pagination to transformed JSON output and return clear parser and execution failures.

### Apply

- Add composable selection sets for slicing occurrences, combining non-overlapping ranges, limiting candidates to scopes, and expanding matches to complete lines.
- Add zero-width start, end, before, and after destinations for inserting copied or moved text without replacing existing content.
- Add symmetric global and document mutation forms, document-scoped flush checkpoints, and deletion through opened document handles.
- Separate the complete Apply scripting reference from the lighter standalone editing guide and prefer content boundaries over unverified line ranges.
- Make batched standalone edits the default for independent, predetermined changes in one or several files; reserve Apply scripts for computed, conditional, or transactional workflows.
- Speed up large Apply transactions by batching text operations while preserving snapshot guards and per-operation outcomes.

### Tool behavior and presentation

- Require project evidence before running built-in formatters, so an installed formatter no longer changes files in an otherwise unconfigured workspace.
- Add Full IDE and Text Editor capability presets, with explicit module choices layered on top.
- Add Full, Compact, and Disabled presentation modes for Apply previews, diffs, Read, Search, and terminal output.
- Bound compact Read rendering for large results so the terminal stays responsive without reducing the content available to the agent.

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
