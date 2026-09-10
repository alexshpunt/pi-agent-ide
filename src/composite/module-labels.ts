/** Human-facing module identity, separate from stable configuration IDs. */
export const moduleLabels = {
  "ide.core": [
    "IDE services",
    "Shared services used by language, formatting and diagnostic modules.",
  ],
  "ide.tips": ["Getting started tips", "Show contextual guidance while setting up a project."],
  "ide.doctor": ["Setup doctor", "Check external tools and help configure project support."],
  "ide.languages": ["Language setup", "Discover languages and their recommended toolchains."],
  "read.core": ["Read tools", "Read sources through the configured readers and views."],
  "read.filesystem": ["Local files", "Resolve files and folders from the local filesystem."],
  "read.filesystem.image": ["Local images", "Read local images as visual content."],
  "read.filesystem.pdf": ["Local PDFs", "Extract readable content from local PDF documents."],
  "read.filesystem.text": ["Local text", "Read local text files with their source coordinates."],
  "read.web": ["Web sources", "Read remote sources over HTTP and HTTPS."],
  "read.web.html": ["Web pages", "Extract readable content from HTML pages."],
  "read.web.image": ["Web images", "Read remote images as visual content."],
  "read.web.pdf": ["Web PDFs", "Extract text from remote PDF documents."],
  "read.web.text": ["Web text", "Read remote plain-text sources."],
  "search.core": ["Search tools", "Run searches through the configured search providers."],
  "search.text": ["Text search", "Find text and files and register reusable search selections."],
  "editor.core": [
    "Editing tools",
    "Apply guarded text and whole-file changes, including Apply scripts.",
  ],
  "editor.renderer": ["Edit previews", "Display changes in the shared colored diff panels."],
  "editor.anchor.constant": [
    "File boundary selectors",
    "Use begin and end to select file boundaries.",
  ],
  "editor.anchor.line-hash": [
    "Checked line selectors",
    "Select lines with hashes that detect stale content.",
  ],
  "editor.anchor.exact": ["Exact text selectors", "Locate edit ranges using unique source text."],
  "editor.stale-anchor": [
    "Stale selection recovery",
    "Provide recovery guidance when an edit selection is outdated.",
  ],
  "ide.ast": [
    "Structural code support",
    "Read code outlines and search or edit exact syntax-tree nodes.",
  ],
  "ide.formatter": ["Code formatting", "Run configured formatters after edits."],
  "ide.lint": ["Lint checks", "Run configured linters and collect their findings."],
  "ide.changes": ["Git changes", "Inspect and manage uncommitted changes and undo history."],
  "ide.lsp": [
    "Language servers",
    "Resolve symbols, rename references and collect language-server diagnostics.",
  ],
  "ide.diagnostics": [
    "Diagnostic views",
    "Show diagnostic findings through read views and sources.",
  ],
} as const;
