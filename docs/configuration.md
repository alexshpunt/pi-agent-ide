# Configuration

Pi Agent IDE enables every built-in extension by default. Project and global config files can disable built-ins by their stable IDs and turn on built-ins that are off by default.

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
  "enabled": ["editor.argument-order"]
}
```

`editor.argument-order` is off by default, so this config turns it on.

An explicit `disabled` entry always beats an explicit `enabled` entry for the same ID.
`enabled` matters only for built-ins marked as off by default; listing an always-on
extension there changes nothing. Enabling a default-off extension also enables its
default-off dependencies unless they are explicitly disabled.

A project config is useful for repository-specific choices. The global config applies to every project. When Pi uses a custom `PI_CODING_AGENT_DIR`, the global config follows that directory.

Restart Pi or use `/reload` after changing extension selection. Search timeout settings are read for every search call.

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

Pi Agent IDE ships working formatter, linter, and LSP mappings. You do not need to copy them into each project. The commands are not bundled: Pi runs them through its current `PATH`.

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

## Doctor

Run `/pi-agent-ide-doctor` to check the effective tools for the current project. Doctor uses the same layered entries as runtime. For each applicable entry it shows the stable ID, source layer, command, and real probe result. A missing or failing command is reported instead of falling back to a lower layer.

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

### Diff view

Edit tool diffs show every diff row by default. The panel keeps completed rows visible and grows as the edit streams in. Set `renderer.diffView` to `"compact"` in `.pi/pi-agent-ide/text-editor.json` to choose a sliding window instead:

```json
{
  "renderer": {
    "diffView": "compact"
  }
}
```

`"full"` is the default and needs no configuration.

## Extension config behavior

- A missing `extensions.json` means every built-in extension is enabled.
- `disabled` and `enabled` must each be an array of unique, non-empty extension IDs.
- The project and global lists are merged; a setting wins at either level.
- Invalid JSON stops Pi Agent IDE from loading.
- An unknown ID stops Pi Agent IDE from loading. This prevents a typo from silently leaving an extension enabled.
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

| ID                        | Contribution                                       |
| ------------------------- | -------------------------------------------------- |
| `editor.anchor.constant`  | `begin` and `end` anchors                          |
| `editor.anchor.line-hash` | Snapshot-aware line anchors                        |
| `editor.anchor.exact`     | Unique exact text spans and recovery               |
| `editor.argument-order`   | Stable mutation argument ordering (off by default) |
| `editor.overwrite`        | Full-file overwrite protection (off by default)    |
| `editor.stale-anchor`     | Stale-anchor recovery behavior                     |

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
