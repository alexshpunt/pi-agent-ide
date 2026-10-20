import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { piRuntime } from "../../../benchmarks/tool-capabilities/inventory.ts";
import { sandboxArgs, runProcess } from "../../../benchmarks/tool-capabilities/sandbox.ts";
import {
  reopenTuiHistory,
  TUI_HISTORY_SESSION,
} from "../../../benchmarks/tool-capabilities/tui.ts";

const [source, root] = process.argv.slice(2);
if (!source || !root) throw Error("Missing history fixture arguments");
const sandbox = await sandboxArgs(source, root);
// Source checkouts can contain unrelated private task state; only trial mounts are visible.
sandbox.splice(-1, 0, "--tmpfs", "/source/.tmp", "--tmpfs", "/source/.pi");
const runtime = await piRuntime("/usr/bin/pi");
// Replica verification borrows dependencies read-only, not personal home/settings/auth.
const dependencies = await realpath(path.join(source, "node_modules"));
if (!dependencies.startsWith(source + path.sep)) {
  const checkout = path.dirname(dependencies);
  for (const name of ["node_modules", "src", "packages", "docs", "package.json"])
    sandbox.splice(-1, 0, "--ro-bind", path.join(checkout, name), path.join(checkout, name));
}
const piArgs = [
  "--approve",
  "--offline",
  "--session",
  TUI_HISTORY_SESSION,
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-mcp",
  "-e",
  "/source/src/pi-agent-ide.ts",
  "-e",
  "/source/tests/integration/fixtures/capability-history-provider.ts",
  "-e",
  "/source/benchmarks/tool-capabilities/observer.ts",
  "--model",
  "history-fixture/history-model",
  "--tools",
  "read",
];
const env = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/state/home",
  PI_CODING_AGENT_DIR: "/state/agent",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_PROGRAM_STATUS: "0",
  CAPABILITY_TUI: "1",
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
};
const first = await runProcess(
  "bwrap",
  [...sandbox, "/usr/bin/pi", ...piArgs, "--", "Read note.txt"],
  { terminal: true, timeoutMs: 25000, env },
);
if (first.code !== 0) throw Error("Initial native history fixture failed");
const providerCallsBefore = await readFile(path.join(root, "state/provider-calls"), "utf8");
const history = await reopenTuiHistory({
  sandbox,
  cli: runtime.cli,
  piArgs,
  state: path.join(root, "state"),
  env,
  timeoutMs: 20000,
});
console.log(
  "\nCAPABILITY_HISTORY_RESULT",
  JSON.stringify({
    execution: history.execution,
    reasons: history.reasons,
    events: history.events,
    providerCallsBefore,
    providerCallsAfter: await readFile(path.join(root, "state/provider-calls"), "utf8"),
    originalSessionHasResult: history.session.includes("HISTORY_NATIVE_BODY_MARKER"),
  }),
);
