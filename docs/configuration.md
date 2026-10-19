# Configuration

## Agent IDE settings

Open `/agent-ide-settings` inside Pi and choose Project or Global. The Features tab lists human-readable module names and descriptions. The Behavior tab lists registered behavior options, including boolean switches and editable text values. Tab switches tabs; typing filters the current list. Enter changes an override, Ctrl+S saves, and Esc cancels.

Default removes the selected scope’s override. Module descriptions show effective state and dependency restrictions. Feature values in project settings override global values. Saving offers a reload for startup-only settings. YOLO policy reads saved values for each request, so its changes affect following operations without reload. The command stays available even when every optional module is disabled.

Boolean overrides are stored under `flags` in `extensions.json`, keyed by their registered setting ID. Choice and text values are stored under `preferences`. External settings use the same menu and scopes but do not add CLI switches. Existing `noAnimations` and `noPostProcessing` fields still work; changing the corresponding feature in the menu replaces that field with its flag override.

Agent Vision adds separate opt-ins for **Capture arbitrary windows** and **Capture full displays**. Both default to off. Its text settings control the default sequence duration, frame interval, image scale, and a comma-separated list of exact executable file names that may be captured without arbitrary-window access. Press Enter to edit a text value, Enter again to commit it, then Ctrl+S to save.

The UI tab contains separate presentation settings for diffs, Read, Search, and terminal output. Each setting supports **Full**, **Compact**, and **Disabled**. Compact is the product default. Full shows all available content, while Disabled keeps only a concise, honest status and still shows failures and warnings. Expanding a tool call always shows the full presentation, regardless of its collapsed preference. These settings affect only the TUI; agent-facing results and tool behavior do not change.

**Show tool results from Codemode** in the UI tab controls extra Agent IDE result panels, not Codemode itself. **Off** is the default: successful IDE panels stay hidden and errors remain visible. **On** shows IDE panels using each tool's own Read, Search, terminal or diff presentation setting. Expanding shows the full retained IDE panels in either mode. Codemode's JavaScript, output and other tools are unchanged. The saved value is `preferences["ui.codemode"]`: `off` or `on`. Project overrides Global; Default removes only the selected scope's override. Reload or restart applies the saved choice.

All user-configurable presentation and behavior preferences belong in Agent IDE settings. New options must carry a human name, explanation and default in their registration. Presentation options belong in the UI tab.

Built-in boolean options that need a Pi CLI flag use `createFeatureFlags().register` with an ID, human name, description and default. External extensions use the [public settings API](extensions.md#settings) for boolean, choice and text settings; no separate menu entry or storage implementation is needed.

Obsolete IDs in `disabled` are ignored. They do not stop IDE startup. Malformed configuration and unknown IDs in `enabled` still report configuration errors.

Pi Agent IDE enables every built-in extension by default. Project and global config files can disable built-ins by their stable IDs and turn on built-ins that are off by default.

## Operation confirmations and YOLO

Open `/agent-ide-settings`, choose Project or Global, and find the YOLO controls in the Behavior tab:

- **YOLO: allow all operations** (`pi-agent-ide-yolo`) skips existing operation dialogs from participating extensions.
- **YOLO: filesystem operations** (`pi-agent-ide-filesystem-yolo`) controls filesystem dialogs separately.
- Loaded extensions can register their own controls, including GitHub and Linear YOLO.

These YOLO settings default to Off. Project overrides Global for each key. An explicit extension On or Off wins over the common setting. Default removes only the selected scope's override: it inherits an extension value from the lower scope, if present, then the common YOLO setting. Set the filesystem override to Off to disable its persistent permission even when common YOLO is On; a remembered session grant still applies. Save with Ctrl+S; the menu offers a reload.

A required operation dialog offers **Deny**, **Allow once**, and **Allow for session**, and points to `/agent-ide-settings`. Deny or dismissal leaves the operation unapplied. Allow once covers only the current request. Allow for session covers later requests with the same extension owner and dialog category, including other targets. It is available when the host can store session entries.

Session grants survive `/reload` and reopening the saved Pi session. They follow its current branch; a new independent session or a branch without the grant asks again. Turning YOLO Off does not remove a remembered session grant.

YOLO and session grants skip confirmation only. Protected paths, hooks, target revalidation and remote authorization still apply. Without UI, an operation that needs confirmation is refused unless YOLO or a session grant permits it. YOLO does not add approval gates to previously ungated routes.

## Agent-assisted settings

Ask the agent to explain Pi Agent IDE or configure it for your tasks. For example: “Help me configure Pi Agent IDE for my workflow.” You can also run `/skill:configure-agent-ide` with your request. For an explanation, the agent describes the relevant settings without changing them. Before making changes, it asks whether to use Project or Global scope unless you already specified it. The shipped skill reads the registered `docs:ide-settings` catalog and both saved scopes before changing only the agreed settings. Default restores inheritance. Saved YOLO changes affect following operations; startup-only changes need reload or restart.

The catalog lists supported settings and defaults, not current effective values. When documentation is disabled, the skill can inspect the installed configuration guide and registrations without enabling unrelated modules.

When the setup skill is available, an interactive TUI session shows a short setup hint once across the installation. Reloads, new projects and package updates do not repeat the same hint. Disabling `ide.tips`, running without the skill or using a non-TUI mode does not consume it. A deliberately revised hint can appear again; the record lives in the existing `pi-agent-ide/tips.json` state file.

For development, enable **Developer mode** in the Behavior tab and reload. This setting (`pi-agent-ide-developer-mode`) defaults to Off and follows Project/Global flag inheritance. Only then is `/agent-ide-tip` available to show the setup hint manually. The command does not reset its one-time state or start a model turn. Automatic startup hints do not require Developer mode.

## Native tool availability

Tools use fixed native exposure; there are no IDE exposure overrides or named profiles.

| Namespace      | Tools                            | Exposure   |
| -------------- | -------------------------------- | ---------- |
| `ide_read`     | `read`, `diff`                   | `direct`   |
| `ide_search`   | `search`                         | `direct`   |
| `ide_edit`     | Standalone editing tools         | `direct`   |
| `ide_terminal` | `bash` (`powershell` on Windows) | `direct`   |
| `ide_git`      | `stage`, `unstage`               | `deferred` |
| `ide_debug`    | `debug`                          | `deferred` |

Direct tools keep their normal calls and can also run through Codemode while active. Select derives exact boundaries; edits consume its snapshot-bound targets.

Git staging and debugger tools are not declared ahead of time. Short agent guidance names the enabled capabilities and tells the agent to find them through native `tool_search`. IDE activates `tool_search` when an enabled deferred capability needs it and the host allows it. Native namespace filtering, BM25 ranking and Codemode declaration budgets apply; workspace `search` still searches workspace content.

Explicit `-name` entries in Pi's `defaultTools` hide matching IDE tools from direct calls, discovery and nested calls. A later `+name` restores the capability and selects it at startup. Pi's CLI allowlist and exclusions still apply: IDE does not restore a tool removed from the host registry. Disabling an IDE module removes its tools rather than leaving a deferred path behind. Discovery guidance omits disabled capabilities.

## Config files

Pi Agent IDE reads these optional files:

```text
<project>/.pi/pi-agent-ide/extensions.json
~/.pi/agent/pi-agent-ide/extensions.json
<project>/.pi/pi-agent-ide/search.json
~/.pi/agent/pi-agent-ide/search.json
```

For `extensions.json`, the project file is read first and the global file is also applied. The lists are merged: if either file disables an ID, that extension stays disabled; `enabled` works the same way for extensions that are off by default.

Example:

```json
{
  "disabled": ["ide.lsp"]
}
```

This config disables the LSP extension.

An explicit `disabled` entry always beats an explicit `enabled` entry for the same ID.
`enabled` matters only for built-ins marked as off by default; listing an always-on
extension there changes nothing. Enabling a default-off extension also enables its
default-off dependencies unless they are explicitly disabled.

A project config is useful for repository-specific choices. The global config applies to every project. When Pi uses a custom `PI_CODING_AGENT_DIR`, the global config follows that directory.

Restart Pi or use `/reload` after changing extension selection. Search timeout settings are read for every search call.

Built-in entry modules are imported only after selection. Disabled built-ins, including those disabled through a dependency, are not imported by the catalog. Selected built-ins still register in catalog order. Shared libraries used by a selected built-in may still load.

## SSH targets

The **SSH files** module (`read.ssh`) reads a separate `ssh.json` beside each `extensions.json`. The global file follows `PI_CODING_AGENT_DIR`. Missing files configure no targets and open no connections. Project targets replace complete global records with the same `id`; other global targets remain available.

Configure targets in the current project's `.pi/pi-agent-ide/ssh.json` by default. Use `~/.pi/agent/pi-agent-ide/ssh.json`, or `$PI_CODING_AGENT_DIR/pi-agent-ide/ssh.json`, only when global access is wanted. Keep personal target records out of shared Git history. Reload Pi after changing targets.

```json
{
  "targets": [{ "id": "sandbox", "host": "vps", "workspace": "/srv/work" }]
}
```

`host` is a trusted OpenSSH alias, optionally `user@alias`. Keys, passwords, host-key trust and agent access stay in OpenSSH configuration, not this file. Optional `configFile` selects a local OpenSSH config; relative paths resolve beside that `ssh.json`. Duplicate IDs within one scope, unknown fields and malformed records stop startup rather than silently enabling a different target.

Use `ssh://sandbox/srv/work/file.txt` with the existing read and text mutation tools. Workspace is the remote path base, not an access boundary; the account's permissions control access. Connections use batch mode and strict host-key verification. Python 3 must be available remotely; no permanent helper is installed.

Remote command channels use Linux child-subreaper support and Python's standard `ctypes` module. The kernel keeps orphaned descendants with their owning channel, including children that open new sessions. Cleanup waits for those children to exit and be reaped; it does not scan or signal unrelated processes. A denied signal or a cleanup deadline remains an explicit unknown result, not proof that the whole tree stopped.

The terminal module reads the same targets. Set `bash`'s `cwd` to `ssh://sandbox/srv/work` to run remote Bash with a PTY. Existing shell resources support input and session cleanup. Remote process identity includes its target; it is never treated as a local PID.

Use `raw:ssh://sandbox/path/file.bin` for original bytes. Offsets and limits count bytes; raw reads do not use text converters or accept views. Byte ranges can cross the text snapshot limit.

Remote resources also support Search, selections, text undo, Git changes and index operations, local/remote transfers, language servers, diagnostics, formatters, linters, and debugger sessions. These providers use the selected Linux target's tools and configuration. Run `/pi-agent-ide-doctor ssh://sandbox/srv/work --no-apply` to inspect an explicitly selected remote project without suggested writes.

For target-native web access, use `web:ssh://sandbox/https://example.com`; ordinary HTTP(S) URLs execute locally. Browser rendering and captures require Node, `playwright-core`, and Chrome or Chromium on the target. Remote process metadata and window/display capture use target-owned resources; native capture also needs a supported graphical environment and the existing vision permissions. Missing dependencies fail without a local fallback.

Text snapshots are limited to 32 MiB. Directory transfers and interrupted remote writes have no distributed rollback; inspect reported effects and both endpoints before retrying an uncertain operation. The settings UI can enable or disable SSH file support; target records are edited in JSON. The agent setup and resource workflow is in the [SSH guide](./agent-guides/ssh.md), available through `read` as `docs:ssh` even before a target is configured.

## Animations and post-edit processing

Standalone editing tools validate source snapshots before writing. Native Codemode commits eligible pending local edits before a dependent tool or when the script ends. Accepted child calls are not proof of persistence. Ordinary script errors keep accepted edits; aborts discard only pending work. Batched edits finish formatting and diagnostics at script end. Write commits earlier pending edits and finishes its own post-edit processing before returning. Text copy/move destinations receive post-processing; binary contents stay unchanged.

Automatic diagnostic findings are grouped for five seconds from the first finding. The UI tab’s **Immediate diagnostic notices** option (`pi-agent-ide-no-diagnostic-buffer`) disables this delay. Combined notices keep each file and reporting tool identifiable. Empty completed diagnostic reads tell the agent that checks finished without findings, but do not draw an empty diagnostic panel. Pending, unavailable and incomplete checks are not reported as clean.

Late diagnostic summaries retain the tool call that produced the checked file version, when known. Split-history extensions can place them beside that call without making edits wait or rewriting completed tool results. A buffered agent notification can cover several calls; the visible summaries keep those owners separate.

Start Pi with either or both flags:

```sh
pi --pi-agent-ide-no-animations --pi-agent-ide-no-post-processing
```

Both settings also belong in `extensions.json`:

```json
{
  "noAnimations": true,
  "noPostProcessing": true
}
```

Both default to `false`. A project boolean overrides the global boolean, including an explicit `false`. A command-line flag forces its setting on for that invocation. Restart Pi or reload after changing the config.

`noAnimations` skips IDE mutation preview playback, interpolation timers and preview preparation. The pending tool header and final static diff remain visible. It does not change model-facing results or disable Pi's own activity indicator.

`noPostProcessing` skips syntax checks used by the post-edit formatting gate, automatic formatting, and automatic diagnostic scheduling after an edit. Requested edits and their safety checks still run. Explicit diagnostic and AST reads remain available and may run their normal tools. This is useful when a benchmark requires exact byte preservation without automatic formatting or diagnostic cache files.

## Search timeout

The complete `search` call has a 30-second timeout by default. This covers resolver work and result formatting. When it expires, the active resolver is cancelled and the agent receives this error:

```text
Search timed out after 30 seconds. Try a smaller path scope.
```

Set a global timeout in `~/.pi/agent/pi-agent-ide/search.json`:

```json
{
  "timeoutMs": 30000
}
```

A project can override it in `<project>/.pi/pi-agent-ide/search.json`. Set `timeoutMs` to `null` at either level to disable the timeout. A project value wins over the global value. Any numeric value must be a positive integer. Invalid search settings reject the search call and name the bad config file.

## Tool configuration

Pi Agent IDE ships formatter, linter, and LSP mappings. You do not need to copy them into each project. Install the tools and their required modules separately. Pi looks in project `node_modules/.bin`, Python `.venv` and `venv` executable directories, `vendor/bin`, and `PATH`. Python environments use `Scripts` on Windows and `bin` elsewhere. Windows command lookup respects `PATHEXT`, including `.cmd` launchers.

Built-in formatters run only when the project contains matching evidence, such as `go.mod`, `Cargo.toml`, `.clang-format`, or a formatter configuration file. An executable being present on the machine and a matching file extension are not enough. Explicit project or global formatter entries remain opt-in configuration and do not require built-in evidence.
You can replace built-in entries or add custom entries in either of these directories:

```text
~/.pi/agent/extensions/pi-agent-ide/
<project>/.pi/pi-agent-ide/
```

Each directory can contain `formatters.json`, `linters.json`, and `lsp-servers.json`. All three layers use the same JSON schema. Pi resolves entries in this order:

1. Project.
2. Global.
3. Built-in.

Entries merge by stable ID. A project entry replaces the whole global or built-in entry with the same ID. A global entry replaces the whole built-in entry. New IDs are allowed. When different IDs match the same file, the entry from the higher layer runs first. Invalid JSON or an invalid entry stops that tool category instead of silently using a lower layer; the other categories still load.

Use a global override for a nonstandard command shared by your projects. Use a project override when one repository needs different behavior. Existing files such as `.clang-format`, `eslint.config.js`, `pyproject.toml`, and `tsconfig.json` remain the source of formatting and lint rules.

Use direct argument arrays in tool commands. Available placeholders are `{file}`, `{relativeFile}`, `{fileDir}`, and `{project}`. Formatter output can be `in-place` or `stdout`. Linters have separate `check` and optional `fix` commands. See the [generated tool catalog](./generated/tool-catalog/index.md) for built-in IDs and commands.

When `PI_CODING_AGENT_DIR` is set, the global directory follows it as `<PI_CODING_AGENT_DIR>/extensions/pi-agent-ide/`. Restart Pi or use `/reload` after changing a configuration file.

### Files without a language extension

Formatter and linter `fileNames` entries match exact basenames, such as `Dockerfile` or `CMakeLists.txt`. A file can match either `extensions` or `fileNames`; existing `include` and `exclude` rules still apply. LSP entries put `fileNames` beside `extensions` inside each language. Basenames are case-insensitive on Windows.

### Framework language servers

An LSP entry can set `requireRootMarker: true`. It then applies only when one of its `rootMarkers` exists in the file's directory or an ancestor inside the project. Markers are relative paths, not globs. The Angular built-in uses `angular.json`, so installing Angular's server does not make it claim ordinary TypeScript or HTML projects. A single-file server can leave this option unset.

JSX and TSX use the LSP language IDs `javascriptreact` and `typescriptreact`, not plain JavaScript and TypeScript.

LSP `initializationOptions` can use `{project}` inside string values, including nested plugin locations. Pi expands it to the absolute project path before starting the server. `settings` values are sent through the LSP configuration protocol.

Vue diagnostics use `typescript-language-server` with the project-local `@vue/typescript-plugin`. Install both, along with TypeScript, and enable the Vue plugin in the native `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@vue/typescript-plugin" }]
  },
  "include": ["src/**/*.vue"]
}
```

The Vue mapping is separate from ordinary TypeScript, so other projects do not load the Vue plugin. This setup does not claim the extra custom commands of `@vue/language-server`.

### Custom diagnostic reporters

Regex diagnostic parsers run with multiline matching. Set `columnBase: 0` when a reporter counts columns from zero; the default is one. Returned diagnostic positions remain one-based. This setting applies only to `format: "regex"` parsers.

A runtime being installed does not prove its modules or language-server features are installed. For example, Taplo's npm build can format TOML but does not include its LSP. Use an LSP-enabled Taplo build for language-server diagnostics. Doctor reports the actual startup failure rather than treating that file as clean.

## Java debugger

Java uses Microsoft java-debug through a private JDT LS process on Linux and native Windows. Kotlin still uses fwcd's adapter.

Install JDK 21 or newer, JDT LS 1.61.0, and `com.microsoft.java.debug.plugin-0.53.2.jar` from vscode-java-debug 0.59.0. Set these variables before starting Pi:

- `PI_JAVA_PATH`: the Java executable. Otherwise Pi uses `JAVA_HOME/bin/java` (`java.exe` on Windows), then `java` on PATH.
- `PI_JDTLS_HOME`: the extracted JDT LS directory, containing `plugins` and `config_linux` or `config_win`.
- `PI_JAVA_DEBUG_PLUGIN_PATH`: the Java debug plugin jar.

Compile with debug information (`javac -g`) before starting the session. Pi finds the main class in `build/classes/java/main`, `target/classes`, `out/production`, `bin`, or the project directory. This launch path does not resolve Maven/Gradle dependency classpaths.

Create the session with `adapter: "java"` and the fully qualified `mainClass`. Use the returned resources to read source, set an anchored breakpoint, start, inspect locals, and continue. Pi keeps the target suspended until attach and breakpoint configuration finish. Deleting the session closes only its own target JVM and JDT LS process. Doctor checks the actual bridge rather than treating a Kotlin adapter as a Java dependency.

## Doctor

Run `/pi-agent-ide-doctor` to check the effective tools for the current project. Doctor uses the same layered entries as runtime. For each applicable entry it shows the stable ID, source layer, command, and real probe result. A missing or failing command is reported instead of falling back to a lower layer.

Use `/pi-agent-ide-doctor ssh://target/path` for an explicitly configured Linux SSH project. Its inventory, project/user-global config and target-sensitive probes belong to that target. Native managed debugger path overrides are read from the target, not the controller. Pure-content adapters, such as jq and fetched-source parsers, stay local. Without a source, the command and passive startup tips keep their local scope. An unused target is not probed.

For an SSH project with vision enabled, Doctor checks the native X11 connection and trusted X-Resource 1.2 support without taking a screenshot or grabbing the desktop. It reports display access and trusted window identity separately. Headless sessions and missing libraries remain warnings. This readiness check does not authorize any particular window or enable capture flags; each real capture still checks opt-in and the selected process.

Doctor can still suggest a project override when project evidence points to a better installed tool. It shows the report before changing anything. `--apply` writes only to `<project>/.pi/pi-agent-ide/`; it never changes the global directory or built-in files. `--agent` delegates remaining setup work, and `--no-apply` skips suggested writes.

The project directory may also contain extension and editor settings:

```text
.pi/pi-agent-ide/
├── extensions.json
├── formatters.json
├── linters.json
├── lsp-servers.json
├── search.json
└── text-editor.json
```

Doctor can send a redacted report and the relevant contributed recipes to the agent when setup still needs work. It runs the checks again after that agent turn.

For automation and tests, `/pi-agent-ide-doctor --apply` accepts suggested mappings without the dialog, `--agent` delegates the remaining work, and `--no-apply` skips deterministic config writes.

### Browser web reads

Automatic browser fallback for HTTP(S) reads needs a system Chrome or Chromium executable. Pi Agent IDE checks common command names on `PATH` and common Linux install paths. Set an exact executable when discovery is not enough:

```bash
export PI_AGENT_IDE_BROWSER_PATH=/path/to/chrome
```

Doctor reports browser support as an optional warning. Direct HTTP(S) reads keep working when no browser is installed.

### Doctor setup tip

At TUI startup, doctor performs a lightweight setup inspection. It uses project languages, native project configuration, installed executables, and the effective project → global → built-in tool selection. It does not start formatters, linters, language servers, or browsers merely to decide whether to show a tip.

No tip appears when built-in mappings already cover the project. Empty projects, unknown languages, and missing optional tools also stay quiet. A tip appears only for a concrete problem, such as an explicitly configured command that is unavailable, or for a supported installed tool that project evidence identifies as a useful change to the active selection. The tip names the detected items and points to `/pi-agent-ide-doctor` for the full report.

Each actionable state has its own stable fingerprint. The same state is shown once per project, while a materially different later problem can produce a new tip. Like other startup tips, it never enters model context. See [Startup tip provider](./extensions.md#startup-tip-provider) for the provider contract and persistence behavior.

### Temporary-directory deletion

For SSH Delete and Move removal checks, all paths and settings belong to the selected target: its account home, system temp, `PI_CODING_AGENT_DIR`, and project config. Local settings do not grant permission to remote paths.

Delete and Move removal checks skip the external/non-Git confirmation for temporary roots and their descendants. By default, any exact `tmp`, `.tmp`, `temp`, or `.temp` component in the resolved path makes it temporary. Similar names such as `my-tmp` do not qualify. The system temporary directory also qualifies and follows the OS environment, such as `TMPDIR` on Linux or `TEMP`/`TMP` on Windows.

Configure this in `<agent-dir>/pi-agent-ide/deletion.json` globally, or `<project>/.pi/pi-agent-ide/deletion.json` for one project. `<agent-dir>` defaults to `~/.pi/agent` and follows `PI_CODING_AGENT_DIR`.

```json
{
  "temporaryDirectories": {
    "mode": "extend",
    "paths": ["scratch", "~/build-scratch"]
  }
}
```

`extend` adds to the lower layer; `replace` replaces it. Layers apply in this order: defaults, global, project. A project replacement overrides both defaults and global settings. Use `{"temporaryDirectories":{"mode":"replace","paths":[]}}` to disable the exception.

Relative global paths start at your home directory; relative project paths start at the worktree root, or cwd without Git. Absolute paths and a leading `~/` are supported. Globs and other shell expansion are not supported. Custom roots resolve symlinks; default name matching uses resolved parent paths, not a symlink spelling. Missing configured roots are skipped. Settings are read for each removal and checked again before effects. Invalid settings block directory/symlink removal rather than falling back.

Tracked/staged contents, failed Git checks inside the current project, and protected project/Git/filesystem paths keep their safeguards. Parent links must resolve inside an allowed root or to a path with an eligible name. Unlinking the final symlink leaves its destination alone. Hooks still apply. Move checks its source and any replaced directory separately; a temporary source does not exempt an ordinary destination. Copy still merges directories and keeps destination-only files. Regular-file deletion is unchanged.

### Exact text recovery

Exact text anchors work without configuration. Optional recovery settings live in `.pi/pi-agent-ide/text-editor.json`:

```json
{
  "recovery": {
    "contextLines": 5,
    "timeoutMs": 2000,
    "exactText": {
      "fuzzyEnabled": true,
      "threshold": 0.8,
      "exactCandidateLimit": 20,
      "fuzzyCandidateLimit": 5,
      "maxFileSizeMiB": 20,
      "maxQuerySizeKiB": 1024,
      "seedLimit": 3,
      "blockLineVariance": 2
    }
  }
}
```

Missing fields use these defaults. Invalid values stop the editor from loading. Fuzzy recovery only returns candidates; it never applies an edit. The safe maxima are 100 exact candidates, 20 fuzzy candidates, 20 context lines, a 10-second timeout, a 100 MiB file, a 4 MiB query, 10 seed lines, and a block variance of 10 lines.

### Diff presentation

Use **Diff presentation** in the Agent IDE settings UI to choose Full, Compact, or Disabled diff panels. Compact is the default and shows a focused sliding window. Full shows every available diff row. Disabled hides diff rows but keeps mutation totals, status, failures, and warnings visible. Expanding a tool call temporarily shows the full diff. The setting applies to standalone mutations, native Codemode edit panels, and the `diff` tool.

## Extension config behavior

- A missing `extensions.json` means every built-in extension is enabled.
- `disabled` and `enabled` must each be an array of unique, non-empty extension IDs.
- The project and global lists are merged; a setting wins at either level.
- Invalid JSON stops Pi Agent IDE from loading.
- Unknown `disabled` IDs are ignored. Unknown `enabled` IDs remain configuration errors.
- Disabling a core also disables built-ins that depend on it.
- The config controls bundled extensions only. It does not disable external Pi extensions.

## Built-in IDs

### Core tools

| ID                | Contribution                                     |
| ----------------- | ------------------------------------------------ |
| `ide.core`        | IDE toolchain protocol                           |
| `ide.tips`        | Passive startup-tip provider core                |
| `ide.doctor`      | `/pi-agent-ide-doctor` and contribution protocol |
| `ide.languages`   | Project language definitions for doctor          |
| `read.core`       | `read` tool and read plugin protocol             |
| `search.core`     | `search` tool and search plugin protocol         |
| `editor.core`     | Text mutation tools and editor protocol          |
| `editor.renderer` | Standard mutation and diff rendering             |

### Read

| ID                      | Contribution                              |
| ----------------------- | ----------------------------------------- |
| `read.filesystem`       | Filesystem Resource resolver              |
| `read.filesystem.image` | Filesystem image content                  |
| `read.filesystem.pdf`   | Filesystem PDF content                    |
| `read.filesystem.text`  | Filesystem text content                   |
| `read.web`              | Direct and browser-rendered web Resources |
| `read.web.html`         | Web HTML conversion                       |
| `read.web.image`        | Web image content                         |
| `read.web.pdf`          | Web PDF content                           |
| `read.web.text`         | Web text content                          |

### Search

| ID            | Contribution               |
| ------------- | -------------------------- |
| `search.text` | Local file and text search |

### Editing and anchors

| ID                        | Contribution                         |
| ------------------------- | ------------------------------------ |
| `editor.anchor.constant`  | `begin` and `end` anchors            |
| `editor.anchor.line-hash` | Snapshot-aware line anchors          |
| `editor.anchor.exact`     | Unique exact text spans and recovery |
| `editor.stale-anchor`     | Stale-anchor recovery behavior       |

### Code intelligence and feedback

| ID              | Contribution                                            |
| --------------- | ------------------------------------------------------- |
| `ide.ast`       | AST scopes, outlines, and structural search             |
| `ide.formatter` | Formatter toolchain integration                         |
| `ide.lint`      | Lint toolchain integration                              |
| `ide.changes`   | Git changes, staging, and undo support                  |
| `ide.lsp`       | LSP symbols, graphs, diagnostics, and compiler feedback |

## Dependency examples

Disabling `search.core` also disables `search.text` and built-ins that contribute search behavior such as `ide.ast` and `ide.lsp`.

Disabling `editor.core` also disables editor anchors, mutation rendering, writable filesystem support, and IDE plugins that require edit events.

For a complete dependency graph, see `src/composite/builtin-extensions.ts`. That registry is the executable source of truth.
