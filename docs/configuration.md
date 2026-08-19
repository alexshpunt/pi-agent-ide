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
  "disabledExtensions": [
    "search.semantic",
    "ide.lsp"
  ]
}
```

Restart Pi or use `/reload` after changing the file.

## Custom path

Set `PI_AGENT_IDE_CONFIG` to read another file:

```bash
PI_AGENT_IDE_CONFIG=./pi-agent-ide.json pi
```

Relative paths are resolved from the current working directory. When Pi uses a custom `PI_CODING_AGENT_DIR`, the default config path follows that directory.

## Behavior

- A missing config file means every built-in is enabled.
- `disabledExtensions` must be an array of unique, non-empty IDs.
- Invalid JSON stops Pi Agent IDE from loading.
- An unknown ID stops Pi Agent IDE from loading. This prevents a typo from silently leaving a module enabled.
- Disabling a core also disables built-ins that depend on it.
- The config controls bundled extensions only. It does not disable external Pi extensions.

## Built-in IDs

### Core tools

| ID | Contribution |
| --- | --- |
| `ide.core` | IDE toolchain protocol |
| `read.core` | `read` tool and read plugin protocol |
| `search.core` | `search` tool and search plugin protocol |
| `editor.core` | Text mutation tools and editor protocol |
| `editor.renderer` | Standard mutation and diff rendering |

### Read

| ID | Contribution |
| --- | --- |
| `read.filesystem` | Filesystem Resource resolver |
| `read.filesystem.image` | Filesystem image content |
| `read.filesystem.pdf` | Filesystem PDF content |
| `read.filesystem.text` | Filesystem text content |
| `read.web` | HTTP and HTTPS Resource resolver |
| `read.web.html` | Web HTML conversion |
| `read.web.image` | Web image content |
| `read.web.pdf` | Web PDF content |
| `read.web.text` | Web text content |

### Search

| ID | Contribution |
| --- | --- |
| `search.text` | Local file and text search |
| `search.semantic` | QMD semantic search |
| `search.web` | Web search |

### Editing and anchors

| ID | Contribution |
| --- | --- |
| `editor.anchor.constant` | `begin` and `end` anchors |
| `editor.anchor.line-hash` | Snapshot-aware line anchors |
| `editor.argument-order` | Stable mutation argument ordering |
| `editor.stale-anchor` | Stale-anchor recovery behavior |

### Code intelligence and feedback

| ID | Contribution |
| --- | --- |
| `ide.ast` | AST scopes, outlines, and structural search |
| `ide.formatter` | Formatter toolchain integration |
| `ide.lint` | Lint toolchain integration |
| `ide.changes` | Git changes, staging, and undo support |
| `ide.lsp` | LSP symbols, graphs, diagnostics, and compiler feedback |

## Dependency examples

Disabling `search.core` also disables `search.text`, `search.semantic`, `search.web`, and built-ins that contribute search behavior such as `ide.ast` and `ide.lsp`.

Disabling `editor.core` also disables editor anchors, mutation rendering, writable filesystem support, and IDE plugins that require edit events.

For a complete dependency graph, see `src/composite/builtin-extensions.ts`. That registry is the executable source of truth.
