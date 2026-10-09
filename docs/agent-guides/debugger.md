# Debugger workflow

Create a session with `debug`, then read the returned `debug:<session>` resource before choosing a breakpoint. Read a source resource with `views: ["anchors"]`; insert `breakpoint` at a current source anchor. Start and control the session by inserting `start`, `continue`, `step over`, `step into`, or `step out` on the session resource. While stopped, insert `evaluate <expression>` to evaluate in the selected stack frame.

Read stopped state before the next action. Use `views: ["breakpoints"]` when breakpoint locations matter. Delete the returned breakpoint resource to remove that breakpoint. Delete the session resource to terminate it. Debug resources survive extension reloads, but program files and anchors may change, so re-read before acting.

Use an SSH `cwd` to create a target-owned session. Relative program and source paths resolve on that workspace; returned source files and frames keep canonical SSH identities. Launch needs the selected native adapter on the target. Unsupported target recipes fail without using a controller adapter. Delete the session to stop its owned transport; do not signal a target PID as if it were local.
