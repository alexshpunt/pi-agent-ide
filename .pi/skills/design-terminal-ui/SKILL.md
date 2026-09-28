---
name: design-terminal-ui
description: Design or change terminal UI that animates, streams, reports progress, updates status, or renders live diffs. Use for dynamic TUI work where native terminal scrollback, row stability, counters, spinners, or completed output can be affected. Do not use for static prose, non-terminal web UI, or source-code changes with no terminal presentation.
---

# Design dynamic terminal UI

Keep old terminal rows trustworthy while new work moves.

## Core rule

Put stable identity and completed information at the head. Put every changing value at the active tail.

A regular terminal can redraw visible screen rows, but it cannot edit native scrollback. If an update changes a row above the renderer's viewport, the application may have to clear and replay the transcript. Avoid that situation by design instead of hiding the clear sequence.

## Separate agent data from user presentation

Treat the tool result sent to the agent and the terminal output shown to the user as separate interfaces, even when they describe the same event.

- Agent-facing data must be technically precise and complete enough for the agent to understand the current state, recover from failures, and continue its work. Include raw diagnostics, identifiers, candidate locations, and recovery details when they help the agent act.
- User-facing data must be clear, calm, and concise. Show the state change, its human-meaningful cause, and any user action that matters. Do not expose raw system messages, stack traces, source dumps, internal anchors, or recovery payloads merely because the agent needs them.
- Design and verify each interface independently. Never render agent-facing payloads directly as terminal UI by default. Derive a deliberate user-facing presentation from the same underlying outcome.

## Inherited backgrounds

Treat the background already supplied by a parent component as part of the child renderer's input. A child must not assume that the terminal default is the surface behind it.

- After wrapping, truncation, highlighting, annotations, and other styling are complete, restore the enclosing background after every SGR sequence that leaves the background unset. This includes `ESC[m`, `ESC[0m`, and `ESC[49m`.
- Leave foreground-only resets alone. Keep an intentional nested background active, then return to the enclosing background when that nested style ends.
- Prefer one shared repair at the final renderer boundary over copies in individual panels. A self-rendered shell owns this repair itself. A nested surface with its own semantic background, such as a diff row or selection, restores that local background before the outer boundary restores the card background.
- Apply the repair before the parent adds its opening background and final reset. Otherwise the repair can color text outside the surface.
- Test the final ANSI bytes as well as the visible text. Use a parent background that differs from the terminal default, force nested resets through real wrapping or truncation, and require each reset inside the surface to resume the expected background. Run the case through the real terminal boundary and inspect it visually too.


## Dynamic output

- Keep titles, tool names, paths, targets, and other known identity stable once shown.
- Put spinners, partial text, progress, elapsed state, and live counters together at the tail.
- Keep changing state at the active tail. Do not hide completed rows just to make the visible output smaller. A streamed diff must show the complete diff generated so far.
- Append completed rows in order and never rewrite them. Freeze a completed file or panel before starting the next one below it.
- Keep motion alive while work is active, even when no new data chunk arrives.
- Report only evidence already available. For a streamed diff, count visible additions and modifications; keep removals at zero until execution establishes them.
- Stop timers when work finishes, fails, is replaced, or the view is disposed.

## Final output

Finish the active tail without replacing the stable rows above it. Preserve semantic colors, wrapping, gutters, links, expansion, omission hints, and accurate final counts. Do not animate a static surface.

## Verification

Test the smallest state transition that could rewrite an old row, then run it through the real terminal boundary. Check that:

1. the head is byte-for-byte stable across active frames;
2. only the active tail changes, while the complete output generated so far stays visible;
3. completed rows or panels remain unchanged and ordered;
4. counters never claim unknown work;
5. no destructive scrollback clear is emitted during the update;
6. the final static view is complete and timers are quiescent;
7. the agent-facing result preserves the technical detail needed for the next action;
8. the user-facing view explains the visible state and useful cause without leaking raw agent diagnostics.
