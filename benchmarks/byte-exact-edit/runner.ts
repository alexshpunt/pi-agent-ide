import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stagePiAuthentication } from "#capabilities/auth.ts";
import { cleanupTrial, runProcess, sandboxArgs } from "#capabilities/sandbox.ts";
import { parseEvents, type RunEvent } from "#capabilities/validation.ts";
import { FIXTURE_FILE, expectedText, fixtureText, type Variant } from "./fixtures.ts";
import { describeGrade, grade, type Grade } from "./grade.ts";

export interface Harness {
  id: string;
  /** Exactly the tools declared to the model; bash is in neither harness. */
  tools: readonly string[];
  /** Extensions loaded from the checkout, which the sandbox mounts read-only at /source. */
  extensions: readonly string[];
  args: readonly string[];
}

export const harnesses: readonly Harness[] = [
  { id: "stock", tools: ["read", "edit"], extensions: [], args: [] },
  {
    id: "ide",
    tools: ["read", "replace", "insert", "delete"],
    extensions: ["/source/src/pi-agent-ide.ts"],
    // The formatter that may run after an edit is not the subject of this benchmark.
    args: ["--pi-agent-ide-no-post-processing", "true"],
  },
];

export const DEFAULT_MODELS = [
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-6.1-terra",
] as const;

export interface Job {
  model: string;
  thinking: string;
  harness: Harness;
  variant: Variant;
  run: number;
}

export const jobId = (job: Job) =>
  `${job.model.replaceAll("/", "_")}--${job.harness.id}--${job.variant.id}--${job.run}`;

/** Pi arguments of one run inside the sandbox; the prompt is the variant's prose task alone. */
export function piArguments(job: Job): string[] {
  return [
    "--approve",
    "--offline",
    "--no-session",
    "--mode",
    "json",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    ...job.harness.extensions.flatMap((extension) => ["-e", extension]),
    "-e",
    "/source/benchmarks/byte-exact-edit/observer.ts",
    "-e",
    "/source/benchmarks/tool-capabilities/auth-guard.ts",
    "--model",
    job.model,
    "--thinking",
    job.thinking,
    "--tools",
    job.harness.tools.join(","),
    ...job.harness.args,
    "--",
    job.variant.prompt,
  ];
}

/** What the observer extension recorded inside the run. */
export interface Runtime {
  model: string | null;
  thinking: string;
  activeTools: string[];
}

export interface Execution {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  runtime?: Runtime;
}

export interface Trial {
  root: string;
  /** The agent's working directory; it holds only the fixture file. */
  workspace: string;
  /** Private Pi home, agent directory and credentials of the run. */
  state: string;
}

export type Executor = (job: Job, trial: Trial, signal: AbortSignal) => Promise<Execution>;

export type RunStatus = "ok" | "model_error" | "infra_error" | "timed_out" | "cancelled";

export interface Row {
  id: string;
  model: string;
  thinking: string;
  harness: string;
  variant: string;
  run: number;
  /** Whether the agent run itself completed; the file is graded either way. */
  status: RunStatus;
  reasons: string[];
  grade: Grade;
  toolCalls: string[];
  toolErrors: number;
}

const fixture = fixtureText();
const original = Buffer.from(fixture);
const expected = new Map<string, Buffer>();

/** Fixture and expected bytes of a variant, generated once per process. */
export function variantFiles(variant: Variant): { original: Buffer; expected: Buffer } {
  let bytes = expected.get(variant.id);
  if (!bytes) {
    bytes = Buffer.from(expectedText(fixture, variant));
    expected.set(variant.id, bytes);
  }
  return { original, expected: bytes };
}

function runStatus(job: Job, execution: Execution, events: RunEvent[], signal: AbortSignal) {
  if (signal.aborted) return { status: "cancelled" as const, reasons: [] };
  if (execution.timedOut) return { status: "timed_out" as const, reasons: [] };
  const failed = events.find(
    (event) =>
      event.type === "message_end" &&
      event.message?.role === "assistant" &&
      ["error", "aborted"].includes(event.message.stopReason ?? ""),
  );
  if (failed)
    return {
      status: "model_error" as const,
      reasons: [failed.message?.errorMessage ?? failed.message?.stopReason ?? "Model failed"],
    };
  if (execution.code !== 0)
    return {
      status: "infra_error" as const,
      reasons: [execution.stderr.trim().slice(-2000) || `Pi exited ${execution.code}`],
    };
  const runtime = execution.runtime;
  if (!runtime) return { status: "infra_error" as const, reasons: ["No runtime record"] };
  const reasons: string[] = [];
  if (runtime.model !== job.model || runtime.thinking !== job.thinking)
    reasons.push(
      `Runtime ran ${runtime.model} ${runtime.thinking}, not ${job.model} ${job.thinking}`,
    );
  const declared = [...runtime.activeTools].sort().join(",");
  if (declared !== [...job.harness.tools].sort().join(","))
    reasons.push(`Declared tools are ${declared}, not ${job.harness.tools.join(",")}`);
  return reasons.length
    ? { status: "infra_error" as const, reasons }
    : { status: "ok" as const, reasons };
}

/** Run one job in a fresh trial directory, keep its raw output in `results`, and grade it. */
export async function runJob(
  job: Job,
  options: { parent: string; results: string; executor: Executor; signal: AbortSignal },
): Promise<Row> {
  const files = variantFiles(job.variant);
  const id = jobId(job);
  const artifacts = path.join(options.results, id);
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(options.parent, "trial-"));
  const trial: Trial = {
    root,
    workspace: path.join(root, "workspace", "fixture"),
    state: path.join(root, "state"),
  };
  const row: Row = {
    id,
    model: job.model,
    thinking: job.thinking,
    harness: job.harness.id,
    variant: job.variant.id,
    run: job.run,
    status: "infra_error",
    reasons: [],
    grade: { result: "missing", lost: {}, added: {} },
    toolCalls: [],
    toolErrors: 0,
  };
  try {
    await mkdir(trial.workspace, { recursive: true });
    await mkdir(path.join(trial.state, "agent"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(trial.state, "home"), { recursive: true });
    await writeFile(path.join(trial.workspace, FIXTURE_FILE), files.original);
    await writeFile(path.join(artifacts, "prompt.txt"), job.variant.prompt);
    let execution: Execution | undefined;
    try {
      execution = await options.executor(job, trial, options.signal);
    } catch (error) {
      row.reasons.push(String(error));
    }
    let events: RunEvent[] = [];
    if (execution) {
      await writeFile(path.join(artifacts, "events.jsonl"), execution.stdout);
      await writeFile(path.join(artifacts, "stderr.log"), execution.stderr);
      try {
        events = parseEvents(execution.stdout);
        Object.assign(row, runStatus(job, execution, events, options.signal));
      } catch {
        row.reasons.push("Pi printed output that is not JSON lines");
      }
    }
    row.toolCalls = events
      .filter((event) => event.type === "tool_execution_start")
      .map((event) => event.toolName ?? "?");
    row.toolErrors = events.filter(
      (event) => event.type === "tool_execution_end" && event.isError,
    ).length;
    const final = await readFile(path.join(trial.workspace, FIXTURE_FILE)).catch(() => undefined);
    if (final) await writeFile(path.join(artifacts, FIXTURE_FILE), final);
    row.grade = grade(job.variant, files.original, files.expected, final);
    return row;
  } finally {
    await cleanupTrial(options.parent, root);
    await writeFile(path.join(artifacts, "result.json"), JSON.stringify(row, null, 2) + "\n");
  }
}

/**
 * Git-ignored paths of the checkout other than `node_modules`, such as `.tmp/` with other runs'
 * credentials and results or `.env` files. The sandbox mounts the checkout read-only and hides
 * these, so a run sees the source and its dependencies only.
 */
export function ignoredPaths(listing: string): { directories: string[]; files: string[] } {
  const directories: string[] = [];
  const files: string[] = [];
  for (const entry of listing.split("\0").filter(Boolean).sort()) {
    if (entry.split("/").includes("node_modules")) continue;
    if (directories.some((directory) => entry.startsWith(directory + "/"))) continue;
    if (entry.endsWith("/")) directories.push(entry.slice(0, -1));
    else files.push(entry);
  }
  return { directories, files };
}

/** Run Pi in the capability matrix's Bubblewrap sandbox with a no-refresh credential snapshot. */
export function sandboxExecutor(options: {
  source: string;
  hidden: { directories: string[]; files: string[] };
  cli: string;
  authDir: string;
  timeoutMs: number;
}): Executor {
  return async (job, trial, signal) => {
    const provider = job.model.slice(0, job.model.indexOf("/"));
    const authentication = await stagePiAuthentication(
      trial.state,
      provider,
      options.authDir,
      options.timeoutMs,
    );
    await writeFile(
      path.join(trial.state, "agent", "settings.json"),
      JSON.stringify({ retry: { enabled: false, maxRetries: 0 } }),
    );
    const sandbox = await sandboxArgs(options.source, trial.root);
    // Hide ignored paths after the /source mount, before the trailing "--chdir DIR --".
    if (sandbox.at(-3) !== "--chdir" || sandbox.at(-1) !== "--")
      throw Error("sandboxArgs no longer ends with --chdir DIR --");
    sandbox.splice(
      -3,
      0,
      ...options.hidden.directories.flatMap((entry) => ["--tmpfs", `/source/${entry}`]),
      ...options.hidden.files.flatMap((entry) => ["--ro-bind", "/dev/null", `/source/${entry}`]),
    );
    const execution = await runProcess(
      "bwrap",
      [...sandbox, "node", options.cli, ...piArguments(job)],
      {
        env: {
          PATH: ["/usr/local/bin", "/usr/bin", "/bin", path.join(os.homedir(), ".local/bin")].join(
            path.delimiter,
          ),
          HOME: "/state/home",
          PI_CODING_AGENT_DIR: "/state/agent",
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
          ...authentication.environment,
          CAPABILITY_AUTH_POLICY: "/state/auth-policy.json",
        },
        timeoutMs: options.timeoutMs,
        signal,
      },
    );
    const runtime = await readFile(path.join(trial.state, "runtime.json"), "utf8").then(
      (text) => JSON.parse(text) as Runtime,
      () => undefined,
    );
    return {
      ...execution,
      stdout: authentication.redact(execution.stdout),
      stderr: authentication.redact(execution.stderr),
      runtime,
    };
  };
}

/** A run passes only when it completed as requested and its file matches byte for byte. */
export const passed = (row: Row) => row.status === "ok" && row.grade.result === "pass";

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** The summary table (passes per model, harness and variant) followed by one line per run. */
export function renderReport(rows: readonly Row[], variants: readonly Variant[]): string {
  const groups = [...new Set(rows.map((row) => `${row.model} ${row.thinking}|${row.harness}`))];
  const summary = groups.map((group) => {
    const [model = "", harness = ""] = group.split("|");
    const own = rows.filter((row) => `${row.model} ${row.thinking}|${row.harness}` === group);
    const score = (list: readonly Row[]) =>
      list.length ? `${list.filter(passed).length}/${list.length}` : "-";
    const cells = variants.map((variant) => score(own.filter((row) => row.variant === variant.id)));
    return `| ${model} | ${harness} | ${cells.join(" | ")} | ${score(own)} |`;
  });
  const runs = rows.map(
    (row) =>
      `| ${row.model} ${row.thinking} | ${row.harness} | ${row.variant} | ${row.run} | ${cell(describeGrade(row.grade))} | ${row.toolCalls.length} | ${row.toolErrors} | ${cell([row.status, ...row.reasons].join(": "))} |`,
  );
  return [
    "## Byte-exact passes",
    "",
    `| Model | Harness | ${variants.map((variant) => variant.id).join(" | ")} | Total |`,
    `|---|---|${variants.map(() => "---|").join("")}---|`,
    ...summary,
    "",
    "## Runs",
    "",
    "| Model | Harness | Variant | Run | Result | Tool calls | Tool errors | Status |",
    "|---|---|---|---|---|---|---|---|",
    ...runs,
    "",
  ].join("\n");
}
