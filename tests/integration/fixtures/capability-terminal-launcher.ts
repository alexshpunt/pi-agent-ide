import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runProcess, sandboxArgs } from "../../../benchmarks/tool-capabilities/sandbox.ts";

const [source, root, mode] = process.argv.slice(2);
if (!source || !root || !mode) throw new Error("Missing lifecycle fixture arguments");
const state = () =>
  execFileSync("stty", ["-g"], { stdio: [0, "pipe", "pipe"], encoding: "utf8" }).trim();
const before = state();
const args = await sandboxArgs(source, root);
const result = await runProcess(
  "bwrap",
  [
    ...args,
    "/usr/bin/pi",
    "--offline",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "-e",
    "/source/tests/integration/fixtures/capability-terminal-idle.ts",
    "--model",
    "anthropic/claude-haiku-4-5",
  ],
  {
    terminal: true,
    timeoutMs: mode === "timeout" ? 5000 : 20000,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/state/home",
      PI_CODING_AGENT_DIR: "/state/agent",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_PROGRAM_STATUS: "0",
      CAPABILITY_FORCE_TIMEOUT: mode === "timeout" ? "1" : "0",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    },
  },
);
console.log(
  "\nCAPABILITY_LIFECYCLE_RESULT",
  JSON.stringify({
    result,
    before,
    after: state(),
    shutdown: existsSync(path.join(root, "state/shutdown")),
    unexpectedRequest: existsSync(path.join(root, "state/unexpected-request")),
  }),
);
