# JSON

Detected extensions: `.json`, `.jsonc`.

| Kind      | Tool                          | Detection                                                                | Documentation                                                             |
| --------- | ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| formatter | `prettier`                    | `.prettierrc`, `.prettierrc.json`, `prettier.config.js`                  | [Official docs](https://prettier.io/docs/)                                |
| formatter | `biome`                       | `biome.json`, `biome.jsonc`                                              | [Official docs](https://biomejs.dev/)                                     |
| formatter | `oxfmt`                       | `.oxfmtrc.json`, `.oxfmtrc.jsonc`, `oxfmt.config.ts`, `oxfmt.config.mts` | [Official docs](https://oxc.rs/docs/guide/usage/formatter.html)           |
| linter    | `jsonlint`                    | `package.json`                                                           | [Official docs](https://github.com/zaach/jsonlint)                        |
| lsp       | `vscode-json-language-server` | `package.json`                                                           | [Official docs](https://github.com/microsoft/vscode-json-languageservice) |
