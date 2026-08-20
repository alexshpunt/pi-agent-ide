# Documentation instructions

Read [`README.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/docs/README.md), [`north-star.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/docs/north-star.md), and [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/north-star.md) before changing this package.

`pi-agent-read` owns the agent-facing read tool, its independent resolver registry, read pipeline, text projection, Pi result projection, and generic plugin protocol. Shared Resource and AgentContent contracts belong to `pi-agent-resource`. Source-specific Resource implementations belong to source integrations.

Do not name concrete source packages, implementation paths, or installed resolver IDs. Extension examples must use clearly fictional `example-*` identities.

The registered tool ID is `read`, and its value is declared only by the real tool definition in `core/tools/tool-read.ts`. The plugin protocol and core must not export, predeclare, or store tool ID values. Event names, core names, diagnostics, and prompt metadata use the `pi-agent-read` domain.

All documents must be written in English. Use package-root absolute paths for internal links.
