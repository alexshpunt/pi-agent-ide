# Configuration

Pi Agent IDE enables every built-in extension by default. A user config can disable built-ins that are not useful in a particular setup.

## Config file

Create:

```text
~/.pi/agent/pi-agent-ide.json
```

Example:

```json
{
  "disabledExtensions": ["search.semantic", "ide.lsp"]
}
```

Restart Pi or use `/reload` after changing the file.

## Custom path

Set `PI_AGENT_IDE_CONFIG` to read another file:

```bash
PI_AGENT_IDE_CONFIG=./pi-agent-ide.json pi
```

Relative paths are resolved from the current working directory. When Pi uses a custom `PI_CODING_AGENT_DIR`, the default config path follows that directory.

## Project setup

Run `/pi-agent-ide-doctor` from a project directory. Doctor collects checks and setup recipes from the extensions that are loaded in the current Pi session. It detects project languages, existing native tool configs, installed executables, AST parsers, search providers, formatters, linters, and language servers.

Doctor shows a report before it changes anything. After confirmation, generated tool mappings are stored in:

```text
.pi/pi-agent-ide/
├── formatters.json
├── linters.json
└── lsp-servers.json
```

These files describe how Pi Agent IDE runs tools. Existing files such as `.clang-format`, `eslint.config.js`, `pyproject.toml`, and `tsconfig.json` remain the source of formatting and lint rules.

Use direct argument arrays in tool commands. Available placeholders are `{file}`, `{relativeFile}`, `{fileDir}`, and `{project}`. Formatter output can be `in-place` or `stdout`. Linters have separate `check` and optional `fix` commands. See the [generated tool catalog](./generated/tool-catalog/index.md) for built-in recipes.

Doctor can send a redacted report and the relevant contributed recipes to the agent when setup still needs work. It runs the checks again after that agent turn.

For automation and tests, `/pi-agent-ide-doctor --apply` accepts suggested mappings without the dialog, `--agent` delegates the remaining work, and `--no-apply` skips deterministic config writes.

## Web search credentials

Project routing is read from `.pi/websearch.json`. Shared credentials can live in `~/.pi/agent/websearch.json`. Credential priority is:

1. provider environment variable;
2. global `~/.pi/agent/websearch.json`;
3. project `.pi/websearch.json`.

Environment variables include `EXA_API_KEY`, `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY`, `PARALLEL_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY`, and provider-specific `PI_AGENT_IDE_SEARCH_<ID>_API_KEY` values. Doctor reports only whether a credential is available. It never prints the value.

## Behavior

- A missing config file means every built-in is enabled.
- `disabledExtensions` must be an array of unique, non-empty IDs.
- Invalid JSON stops Pi Agent IDE from loading.
- An unknown ID stops Pi Agent IDE from loading. This prevents a typo from silently leaving a module enabled.
- Disabling a core also disables built-ins that depend on it.
- The config controls bundled extensions only. It does not disable external Pi extensions.

## Built-in IDs

### Core tools

| ID                | Contribution                                     |
| ----------------- | ------------------------------------------------ |
| `ide.core`        | IDE toolchain protocol                           |
| `ide.doctor`      | `/pi-agent-ide-doctor` and contribution protocol |
| `ide.languages`   | Project language definitions for doctor          |
| `read.core`       | `read` tool and read plugin protocol             |
| `search.core`     | `search` tool and search plugin protocol         |
| `editor.core`     | Text mutation tools and editor protocol          |
| `editor.renderer` | Standard mutation and diff rendering             |

### Read

| ID                      | Contribution                     |
| ----------------------- | -------------------------------- |
| `read.filesystem`       | Filesystem Resource resolver     |
| `read.filesystem.image` | Filesystem image content         |
| `read.filesystem.pdf`   | Filesystem PDF content           |
| `read.filesystem.text`  | Filesystem text content          |
| `read.web`              | HTTP and HTTPS Resource resolver |
| `read.web.html`         | Web HTML conversion              |
| `read.web.image`        | Web image content                |
| `read.web.pdf`          | Web PDF content                  |
| `read.web.text`         | Web text content                 |

### Search

| ID                | Contribution               |
| ----------------- | -------------------------- |
| `search.text`     | Local file and text search |
| `search.semantic` | QMD semantic search        |
| `search.web`      | Web search                 |

### Editing and anchors

| ID                        | Contribution                      |
| ------------------------- | --------------------------------- |
| `editor.anchor.constant`  | `begin` and `end` anchors         |
| `editor.anchor.line-hash` | Snapshot-aware line anchors       |
| `editor.argument-order`   | Stable mutation argument ordering |
| `editor.stale-anchor`     | Stale-anchor recovery behavior    |

### Code intelligence and feedback

| ID              | Contribution                                            |
| --------------- | ------------------------------------------------------- |
| `ide.ast`       | AST scopes, outlines, and structural search             |
| `ide.formatter` | Formatter toolchain integration                         |
| `ide.lint`      | Lint toolchain integration                              |
| `ide.changes`   | Git changes, staging, and undo support                  |
| `ide.lsp`       | LSP symbols, graphs, diagnostics, and compiler feedback |

## Dependency examples

Disabling `search.core` also disables `search.text`, `search.semantic`, `search.web`, and built-ins that contribute search behavior such as `ide.ast` and `ide.lsp`.

Disabling `editor.core` also disables editor anchors, mutation rendering, writable filesystem support, and IDE plugins that require edit events.

For a complete dependency graph, see `src/composite/builtin-extensions.ts`. That registry is the executable source of truth.
