# Known gaps

This document lists only current gaps owned by `pi-agent-text-editor`.

## Multi-file copy and move

`copy` and `move` currently require the target to be the source Resource. Cross-Resource mutation needs one explicit transaction model before these tools can support another target.

## History and batches

The current tools perform one mutation per call. Batch execution, undo, and redo are not implemented in this editor core.

## Anchor result presentation

Mutation results do not ask the active major resolver to render fresh post-edit anchors. Read presentation remains the way to obtain new anchors after a change.
