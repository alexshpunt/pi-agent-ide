# PowerShell

Detected extensions: `.ps1`, `.psm1`, `.psd1`.

| Kind      | Tool                         | Detection                       | Documentation                                                                                         |
| --------- | ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| formatter | `powershell-format`          | `PSScriptAnalyzerSettings.psd1` | [Official docs](https://learn.microsoft.com/powershell/module/psscriptanalyzer/invoke-formatter)      |
| linter    | `psscriptanalyzer`           | `PSScriptAnalyzerSettings.psd1` | [Official docs](https://learn.microsoft.com/powershell/module/psscriptanalyzer/invoke-scriptanalyzer) |
| lsp       | `powershell-editor-services` | `PSScriptAnalyzerSettings.psd1` | [Official docs](https://github.com/PowerShell/PowerShellEditorServices)                               |
