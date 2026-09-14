# Python

Detected extensions: `.py`, `.pyi`.

| Kind      | Tool           | Detection                                              | Documentation                                           |
| --------- | -------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| formatter | `ruff-format`  | `ruff.toml`, `.ruff.toml`, `pyproject.toml: tool.ruff` | [Official docs](https://docs.astral.sh/ruff/formatter/) |
| formatter | `black`        | `pyproject.toml: tool.black`                           | [Official docs](https://black.readthedocs.io/)          |
| linter    | `ruff`         | `pyproject.toml`, `ruff.toml`, `.ruff.toml`            | [Official docs](https://docs.astral.sh/ruff/)           |
| lsp       | `basedpyright` | `pyproject.toml`, `pyrightconfig.json`                 | [Official docs](https://docs.basedpyright.com/)         |
