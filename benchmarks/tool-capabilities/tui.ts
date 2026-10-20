import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessResult } from "./sandbox.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One actual native session file is created and reopened inside the same private trial. */
export const TUI_HISTORY_SESSION = "/state/capability-history.jsonl";

/** Raw private values are returned only to the caller's existing secret-redaction boundary. */
export async function reopenTuiHistory(options: {
  sandbox: string[];
  cli: string;
  piArgs: string[];
  state: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  execution: ProcessResult;
  events: string;
  session: string;
  reasons: string[];
}> {
  const separator = options.sandbox.lastIndexOf("--");
  if (
    separator < 0 ||
    options.sandbox.includes("--share-net") ||
    options.piArgs[options.piArgs.indexOf("--session") + 1] !== TUI_HISTORY_SESSION ||
    options.piArgs.includes("--no-session")
  )
    throw Error("History reopening requires the original private session and isolated launcher");
  const session = await readFile(path.join(options.state, "capability-history.jsonl"), "utf8");
  // Startup hooks cannot make hidden inference requests during screenshot inspection.
  const sandbox = [...options.sandbox];
  sandbox.splice(separator, 0, "--unshare-net");
  const execution = await runProcess(
    "bwrap",
    [...sandbox, "node", options.cli, ...options.piArgs],
    {
      env: { ...options.env, CAPABILITY_TUI_HISTORY: "restore" },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      terminal: true,
    },
  );
  let events = "";
  let reasons: string[];
  try {
    events = await readFile(path.join(options.state, "history-events.jsonl"), "utf8");
    reasons = validateTuiHistory(
      events
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    );
  } catch {
    reasons = ["History observations are unavailable or malformed"];
  }
  if (execution.timedOut) reasons.push("History inspection timed out");
  else if (execution.code !== 0 || execution.signal)
    reasons.push("History inspection did not exit normally");
  return { execution, events, session, reasons };
}

/** Keep a live terminal invocation to one explicitly selected paid attempt. */
export function assertTuiInvocation(selection: {
  run: boolean;
  models?: string[];
  cases?: string[];
  mode?: string;
  attempts: number;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): void {
  if (
    !selection.run ||
    selection.models?.length !== 1 ||
    !selection.models[0] ||
    selection.cases?.length !== 1 ||
    !selection.cases[0] ||
    !["direct", "codemode"].includes(selection.mode ?? "") ||
    selection.attempts !== 1
  )
    throw Error("--tui requires --run, one explicit --model, --case and --mode, and one attempt");
  if (!selection.stdinIsTTY || !selection.stdoutIsTTY)
    throw Error("--tui requires a real terminal for stdin and stdout");
}

/** History adds an idle reopening, never another prompt or a headless route. */
export function assertTuiHistoryInvocation(args: readonly string[]): void {
  if (args.includes("--tui-history") && !args.includes("--tui"))
    throw Error("--tui-history requires --tui");
}

/** Mirror public lifecycle/execution observations without replacing native terminal rendering. */
export function mirrorTuiEvents(pi: ExtensionAPI, file: string): void {
  // Keep callback-time events unchanged, including nested ids, raw aliases and failed executions.
  // Streaming deltas are not needed by the existing route/outcome validators.
  const events = [
    "agent_start",
    "agent_end",
    "agent_settled",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
  ] as const;
  appendFileSync(
    file,
    JSON.stringify({ type: "capability_capture", surface: "tui", events }) + "\n",
  );
  const record = (event: unknown) => {
    appendFileSync(file, JSON.stringify(event) + "\n");
  };
  pi.on("agent_start", record);
  pi.on("agent_end", record);
  pi.on("agent_settled", record);
  pi.on("message_end", record);
  pi.on("tool_execution_start", record);
  pi.on("tool_execution_end", record);
}

/** Block all agent/provider work while Pi renders the original persisted session. */
export function guardTuiHistory(pi: ExtensionAPI, file: string): void {
  const record = (event: unknown) => appendFileSync(file, JSON.stringify(event) + "\n");
  pi.on("session_start", (_event, context) => {
    const entries = context.sessionManager.getEntries();
    const messages = entries.filter((entry) => entry.type === "message").length;
    const sessionFile = context.sessionManager.getSessionFile();
    const restored = sessionFile === TUI_HISTORY_SESSION && messages > 0;
    record({
      type: "history_restored",
      restored,
      sessionFile,
      sessionId: context.sessionManager.getSessionId(),
      messages,
    });
    if (!restored) context.shutdown();
    else {
      context.ui.setStatus(
        "capability-history",
        "LPT769_HISTORY_RESTORED · offline · no inference",
      );
      process.stdout.write("\nLPT769_HISTORY_RESTORED\n");
    }
  });
  pi.on("agent_start", (_event, context) => {
    record({ type: "history_agent_start_refused" });
    context.abort();
    context.shutdown();
  });
  pi.on("before_provider_request", (_event, context) => {
    record({ type: "history_provider_request_refused" });
    context.abort();
    context.shutdown();
    throw Error("History inspection forbids provider requests");
  });
}

/** Restoration has its own evidence and must not contaminate first-run route validation. */
export function validateTuiHistory(events: readonly unknown[]): string[] {
  const valid = events.filter(
    (event): event is { type: string; restored?: boolean } =>
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      typeof event.type === "string",
  );
  if (valid.length !== events.length) return ["Invalid history observation record"];
  const restored = valid.filter((event) => event.type === "history_restored");
  if (restored.length !== 1 || restored[0]?.restored !== true)
    return ["The original saved session was not observed during history startup"];
  if (valid.some((event) => event.type.endsWith("_refused")))
    return ["History inspection attempted agent or provider work"];
  if (valid.some((event) => event.type !== "history_restored"))
    return ["Unexpected activity during history inspection"];
  return [];
}
