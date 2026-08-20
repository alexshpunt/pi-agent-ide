# `pi-agent-pdf`

## Purpose

`pi-agent-pdf` recognizes PDF documents from bytes and extracts their text into provider-neutral AgentContent.

The package uses PDF.js, preserves page boundaries as Markdown headings, and marks pages without extractable text. It owns no filesystem or network I/O and does not use filenames as format authority. Filesystem and web adapters install the same converter for their respective read targets.

The initial converter extracts the PDF text layer. It does not OCR scanned pages or render page images.
