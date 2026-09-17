# Diagnostics workflow

Read `diagnostics:<path>` or add the `diagnostics` view to inspect file findings. Reports name the actual source and distinguish completed results, snapshots, pending checks, and unavailable providers. Silence and empty snapshots do not prove a file is clean.

Use diagnostics for focused file feedback; use the project's build or test command for whole-project verification. After edits, wait for or explicitly request the relevant completed check. Do not run a fixer when the task only calls for diagnosis.
