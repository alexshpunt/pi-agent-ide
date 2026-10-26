# Debugger workflow

Create a session with `debug`, then read the returned `debug:<session>` resource before choosing a breakpoint. Read a source resource with `views: ["anchors"]`; insert `breakpoint` at a current source anchor. Start and control the session by inserting `start`, `continue`, `step over`, `step into`, or `step out` on the session resource. While stopped, insert `evaluate <expression>` to evaluate in the selected stack frame.

Read stopped state before the next action. Use `views: ["breakpoints"]` when breakpoint locations matter. Delete the returned breakpoint resource to remove that breakpoint. Delete the session resource to terminate it. Debug resources survive extension reloads, but program files and anchors may change, so re-read before acting.

A session reporting adapter `vscode` runs in the user's VS Code window through DebugMCP; the same resources and actions apply. Its breakpoints and debug session are visible to the user. It shows aggregate values as `<complex value>`; evaluate an expression that formats the value, such as `repr(items)` in Python, to read it. Use `configuration` to launch a `.vscode/launch.json` entry when the program needs arguments or environment or is a compiled executable, and `test` to debug one test. Pass `backend: "native"` with an `adapter` to keep debugging outside VS Code. If `backend: "vscode"` fails, its error names the unmet condition; open the workspace in VS Code or use the native backend.

Use an SSH `cwd` to debug on a remote target (see `docs:ssh`); the adapter must be installed there.
