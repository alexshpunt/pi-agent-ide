# Debugger workflow

Create a session with `debug`, then read the returned `debug:<session>` resource before choosing a breakpoint. Read a source resource with `views: ["anchors"]`; insert `breakpoint` at a current source anchor. Start and control the session by inserting `start`, `continue`, `step over`, `step into`, or `step out` on the session resource. While stopped, insert `evaluate <expression>` to evaluate in the selected stack frame.

Read stopped state before the next action. Use `views: ["breakpoints"]` when breakpoint locations matter. Delete the returned breakpoint resource to remove that breakpoint. Delete the session resource to terminate it. Debug resources survive extension reloads, but program files and anchors may change, so re-read before acting.
