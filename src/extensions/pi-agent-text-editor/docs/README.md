# `pi-agent-text-editor` documentation

`pi-agent-text-editor` owns source-neutral text mutation, its Resource registry, and its text anchor resolver registry. Shared anchor contracts live in [`pi-agent-text`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-text/north-star.md), shared I/O contracts live in [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/north-star.md), and reading lives in [`pi-agent-read`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/docs/README.md).

## Reading order

1. [`north-star.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/north-star.md) defines the editor boundary.
2. [`plugins/plugin-protocol.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/plugins/plugin-protocol.md) defines plugin registration, Resource resolvers, and anchor resolvers.
3. [`plugins/edit-pipeline.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/plugins/edit-pipeline.md) defines mutation execution.
4. [`plugins/read/pipeline/read/text-hash-anchor.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/plugins/read/pipeline/read/text-hash-anchor.md) defines the standalone line-hash extension.
5. Read the affected source or language extension document before changing it.

[`legacy/initial-plan.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-text-editor/docs/legacy/initial-plan.md) is historical context only.
