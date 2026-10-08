# Directory and symlink operations

Delete, Copy, and Move accept ordinary filesystem paths without text selectors. The same implementation runs for standalone calls and calls nested in native Codemode. Read results, directory listings, and other registered selections do not become whole-directory authority.

## Capability table

| Operation | Directory behavior                                                                                                                                              | Symlink behavior                                                                          | Guards and failure effects                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delete    | Remove the directory and all contents recursively.                                                                                                              | Unlink only the link, including a broken link. Never follow links inside a removed tree.  | Existing before-delete hooks, protected paths, and host approval policy apply. Refusal is `not-applied`; a filesystem failure after removal starts is `unknown`.                                                                                                                                             |
| Copy      | Copy into the exact target path. Create missing parents. Merge into an existing directory, overwrite matching regular files, and keep destination-only entries. | Copy link text without following the target, including standalone and broken links.       | Preflight the source tree and matching destination entries. Refuse aliases, overlapping trees, symlink destinations, unsupported object types, and type conflicts before writes. Protect project roots, ancestors, and current Git control data from recursive overwrites. After-start failure is `unknown`. |
| Move      | Move into the exact target path. Create missing parents. Replace an existing directory, removing its old destination-only entries.                              | Move the link object without following its target, including standalone and broken links. | Apply Copy's top-level transfer checks and Delete's safety policy to directory/link source removal and existing destination removal. Recheck both approved objects before execution. After-start failure is `unknown`.                                                                                       |

A target names the resulting object, not a containing directory with an implicit source-name child. For example, Copy from `source` to `new/target` produces `new/target/nested`, not `new/target/source/nested`.

Symlink text is preserved exactly. A relative link can point somewhere different after relocation. Existing symlink destinations are rejected, even if their referents match. Copy also rejects a conflicting link at any matching destination entry. Destination-only links are left alone by Copy; replacing a Move destination removes the links, not their referents. File/directory/link type conflicts are refused rather than converted.

Only regular files, directories, and symlink objects are supported within source trees. Recursive transfers preserve file bytes and empty directories; they do not promise preserved timestamps, ownership, or hard-link relationships. Directory and link targets are not post-processed as text and have no reusable text selection. Inspect their ordinary paths with Read.

## Move safety policy

For directory and symlink Move sources, and existing directory destinations, the same before-delete hook runs before any removal or dialog. Denial or a thrown hook error blocks the transfer. Tracked or newly staged entries, external targets, missing Git worktrees, and failed Git checks require host approval. No available dialog means no transfer. Untracked internal targets need no dialog. There is no agent approval argument.

Protected project roots, ancestors, filesystem roots, and current Git control paths cannot be moved or recursively overwritten. Parent symlinks are resolved for identity, containment, and project-boundary checks; the final link object is not dereferenced. The project boundary is the Git worktree containing Pi's cwd. Without Git, cwd and its ancestors remain protected.

Move obtains all required approvals and rechecks each object afterwards. Changes to identity, Git classification, source-tree entries, or matching destination entries during preflight prevent dispatch. These checks are not an atomic filesystem lock against other processes. Ordinary-file overwrite behavior and selected-text editing remain unchanged.

For hook setup and the existing Delete policy, see [File hooks](user-hooks.md).

## Cross-device moves, cancellation, and partial failure

Move first attempts a filesystem rename. On a cross-device error, the filesystem library copies the object and then removes the source. The copy and removal phases can fail separately. Replacement may already have removed destination contents when a later phase fails.

Cancellation before filesystem execution prevents the transfer. The recursive filesystem primitives are not interruptible through the tool's abort signal once dispatched; in-flight work may finish. A failed filesystem call after dispatch reports `unknown`, even when the precise effects cannot be established.

There is no recursive undo or atomic rollback. After an unknown result, inspect both source and target before deciding whether to retry. Earlier successful operations in the same Codemode script are not rolled back when a later operation fails.

## Executable checks

- [Transfer unit tests](../src/extensions/pi-agent-text-editor/tests/core/directory-transfers.test.ts): binary bytes, empty directories, link text, merge/replace behavior, aliases, nested destinations, conflicts, hooks/approvals, changed objects, cancellation, real Linux cross-device moves, and controlled partial failures.
- [Delete policy unit tests](../src/extensions/pi-agent-text-editor/tests/core/delete-policy.test.ts): deletion guards and uncertain recursive effects.
- [Real-Pi transfer cases](../tests/integration/directory-transfers.integration.test.ts): direct and native Codemode transfers, preserved source/sentinel bytes, host approval, and refusal paths.
- [Real-Pi Delete cases](../tests/integration/delete-objects.integration.test.ts): both call routes and fail-closed host guards.
- [Paid capability matrix](../benchmarks/tool-capabilities/README.md): executable `directory-transfers` and `directory-transfer-gates` cases have direct and Codemode routes. They are not model-verified until explicitly run with paid permission. Free coverage checks do not prove model execution.

These contracts are checked on Linux/WSL. The cross-device test uses `/dev/shm` and runs only on Linux. Other operating systems are not verified by that test.
