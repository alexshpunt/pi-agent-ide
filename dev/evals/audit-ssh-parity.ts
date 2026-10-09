import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceEvent } from "pi-coding-agent-test";
import { agentRounds, serviceOutcome } from "./ssh-parity.config.js";

interface Trial {
  taskId: string;
  agentProfile: string;
  attempt: number;
  effectiveModel: { provider: string; id: string };
  effectiveThinking: string;
  effectiveTools: string[];
  effectiveExtensions: string[];
  elapsedSeconds: number;
  score: {
    passed: boolean;
    details: { trajectory: { tool: string; error: boolean; conflict: boolean }[] };
  };
  customMetrics: { "tool-context-bytes": number };
  agentMetrics: { failedToolCalls: number; toolCalls: number };
}

// Keep original trial scores untouched. A sidecar makes validator corrections explicit.
const input = process.argv[2];
if (input === undefined) throw new Error("Pass one completed ssh-parity run directory");
const run = path.resolve(input);
const rows: string[] = [];
const settings = new Set<string>();
let count = 0;
let passed = 0;
let model: string | undefined;
let thinking: string | undefined;
for (const folder of (await readdir(path.join(run, "trials"))).sort()) {
  const directory = path.join(run, "trials", folder);
  const trial = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")) as Trial;
  model = `${trial.effectiveModel.provider}/${trial.effectiveModel.id}`;
  thinking = trial.effectiveThinking;
  settings.add(
    JSON.stringify([
      trial.effectiveModel,
      trial.effectiveThinking,
      trial.effectiveTools,
      trial.effectiveExtensions,
    ]),
  );
  const records = (await readFile(path.join(directory, "agent/run.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind?: string; event?: TraceEvent });
  const traceEvents = records.flatMap((row) =>
    row.kind === "trace" && row.event !== undefined ? [row.event] : [],
  );
  const rounds = agentRounds({ traceEvents });
  if (rounds === 0) throw new Error(`No actual assistant turns in ${folder}`);
  const outcome = trial.taskId === "service" ? serviceOutcome({ traceEvents }) : trial.score.passed;
  count += 1;
  passed += Number(outcome);
  const trajectory = trial.score.details.trajectory
    .map((step) => `${step.tool}${step.conflict ? "(conflict)" : step.error ? "(error)" : ""}`)
    .join(" → ");
  rows.push(
    `| ${trial.taskId} | ${trial.agentProfile} | ${outcome ? "pass" : "fail"} | ${trial.score.passed ? "pass" : "fail"} | ${rounds} | ${trial.agentMetrics.failedToolCalls} | ${trial.customMetrics["tool-context-bytes"]} | ${trial.elapsedSeconds.toFixed(2)} | ${trajectory} |`,
  );
}
if (settings.size !== 1)
  throw new Error("Compared trials have different effective model, thinking, tools or extensions");
const report = [
  "# SSH parity: audited recorded run",
  "",
  `Run: ${run}`,
  `Model: ${model ?? "unavailable"}; thinking: ${thinking ?? "unavailable"}.`,
  "",
  "This audit reuses completed Pi recordings. It does not rerun a model, touch a fixture, or change historical trial scores.",
  "Assistant turns come from real message_start events; providerRequests is scripted-provider telemetry and was empty for this real provider.",
  "Service validation accepts the existing structured shell Read header as well as Bash metadata, requires exit 0 and actual result output, and verifies deletion of that exact shell source. The first validator missed a successful interactive SSH service.",
  "",
  "Effective model, thinking, tools and extensions match across every recorded trial. Task instructions are shared; prepared local/SSH resource identities differ by design.",
  "",
  "| Task | Backend | Audited | Original score | Rounds | Tool errors | Context bytes | Seconds | Recovery trajectory |",
  "| -- | -- | -- | -- | --: | --: | --: | --: | -- |",
  ...rows,
  "",
  `Observed outcomes: ${passed}/${count}. This small paired sample is evidence for these tasks, not a speed benchmark or complete matrix acceptance.`,
  "",
].join("\n");
const output = path.join(run, "audited-summary.md");
await writeFile(output, report);
console.log(report);
