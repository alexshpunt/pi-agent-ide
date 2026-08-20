# Documentation instructions

Read [`README.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/README.md), [`north-star.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/north-star.md), and [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/north-star.md) before changing this package.

`pi-agent-text-editor` owns its independent resolver registry, plugin protocol, tool-scoped API, Resource-based text mutation boundary, and `text-pre-edit`, `text-edit`, and `text-post-edit` pipeline. Shared Resource selection contracts belong to `pi-agent-resource`; source implementations remain outside the editor.

Generic agent reading, read pipeline stages, and read projection belong to `pi-agent-read`. The editor may register editor-owned handlers through the public read plugin API.

Do not add mutation tool implementations unless the task explicitly requests them.

Anchor formats belong to independent resolver extensions. Shared anchor contracts stay in `pi-agent-text`; registry and mutation behavior stay in `pi-agent-text-editor`; read presentation uses the public `pi-agent-read` API.

All documents must be written in English. Use package-root absolute paths for internal links.
