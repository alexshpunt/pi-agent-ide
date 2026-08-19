<p align="center">
  <img src="assets/banner.png" alt="Pi Agent IDE" width="100%">
</p>

<h1 align="center">Pi Agent IDE</h1>

<p align="center">Agent-facing tools for reading, searching, and editing code in <a href="https://pi.dev/">Pi</a>.</p>

## Status

Pi Agent IDE is experimental and under active development. It is used in real work, but bugs and rough edges are still being found and fixed. Interfaces and behavior may change.

The current focus is measurement. The project is being compared with vanilla Pi on evals and editing gyms to understand where its tools improve results or reduce tool use and token use. Some workflows already benefit from the tools; others become harder. Until the data is stronger, treat performance claims as unproven and use the package at your own risk.

## What it does

Pi Agent IDE provides a small set of tools with more specialized behavior behind them:

- `read` handles files, web pages, images, PDFs, code views, and diagnostics;
- `search` routes text, structural, semantic, and web searches;
- `write`, `replace`, `insert`, `delete`, `copy`, and `move` cover common text mutations; range-based edits can target snapshot and semantic anchors instead of reproducing the `oldText` block required by Pi's built-in `edit` tool;
- optional plugins add AST, LSP, formatting, linting, and Git-aware behavior.

The public interface is intentionally small. Resources, resolvers, anchors, renderers, and toolchain integrations are connected through versioned plugin protocols. The npm package loads as one Pi extension, while its built-ins remain separate modules that can be replaced or extended.

## Installation

Install [Pi](https://pi.dev/) first, then install Pi Agent IDE:

```bash
pi install npm:pi-agent-ide
```

Pi packages run with your full system permissions. Review the package before installing it.

## Documentation

| Document | Contents |
| --- | --- |
| [Tools and workflow](./docs/tools.md) | Read, search, editing, anchors, and feedback |
| [Architecture](./docs/architecture.md) | Module boundaries, protocols, and the umbrella extension |
| [Configuration](./docs/configuration.md) | Disable built-ins and select a config file |
| [Writing extensions](./docs/extensions.md) | Add resolvers, anchors, search backends, and IDE plugins |
| [Development](./docs/development.md) | Work from a checkout, test, and build the public package |
| [Evaluation](./docs/evaluation.md) | Compare Pi Agent IDE with vanilla Pi on repeatable tasks |

## Repository

Executable behavior is defined by the source and tests. The documents above explain the intended boundaries, extension contracts, and development workflows.

## License

[MIT](./LICENSE)
