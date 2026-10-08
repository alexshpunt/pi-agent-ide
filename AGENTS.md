# Tool capability checks

When changing an IDE tool or its supported composition with another tool, review and update the paid capability matrix and affected executable cases in `benchmarks/tool-capabilities/`. This is required even when the tool schema stays the same.

Run `pnpm check:capabilities` without inference. See `benchmarks/tool-capabilities/README.md` for the maintenance steps and paid runner. Paid runs are separate from ordinary tests and need explicit model/cost permission. Unrun routes stay unverified; keep failed attempts visible.
