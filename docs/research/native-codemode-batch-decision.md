# Solution decision: accumulate sequential Codemode text edits

## Question

Should sequential editor calls in native Codemode share only original coordinates, or also one combined write, and where should that batch end?

## Decision

The user chose an original snapshot and one combined write, not immediate writes with coordinate translation.

Sequential text-edit calls accept checked changes into a pending batch. Before commit, their results must say the changes are accepted and not yet applied. They must not present a final written file or claim the operation is committed.

The batch ends before another tool runs or when the script finishes. A read, search or terminal call after edits must see committed files. Later edits start a new batch with a new snapshot. A mode of an editor tool that cannot join the text batch also needs a boundary before its own effects.

An ordinary script exception does not discard accepted independent edits. Finish those edits and report both their commit result and the script failure. A rejected operation does not become an accepted edit.

Do not replace or re-register native Codemode, change Apply exposure, bypass Pi's tool pipeline, or silently repair stale anchors by searching for similar text. Preserve the existing direct-call batch behavior.

This is a behavior decision from the discussion, not implementation approval. Cancellation of pending writes and final reporting still need a concrete checked design.

## Why

The user wants the same original-snapshot approach as the direct editor batch. Translating coordinates while writing after every call would preserve only part of that behavior. Waiting for future awaited calls would deadlock the script, so earlier calls must return before the combined write.

Flushing before another tool gives that tool real committed files rather than an invisible virtual workspace. Keeping accepted independent edits after an ordinary script error follows the user's explicit choice.

[Research and source evidence](native-codemode-batching.md) records the existing mechanisms and the unproven boundaries. The failing [sequential real-Pi test](../../tests/integration/native-codemode.integration.test.ts) remains the current reproduction.
