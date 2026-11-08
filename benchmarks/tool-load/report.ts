import type { AgentResult } from "./agent.ts";
import type { MachineSample } from "./sampler.ts";

export type ProbeRecord =
  | { readonly type: "start"; readonly t: number; readonly pid: number }
  | {
      readonly type: "sample";
      readonly t: number;
      readonly rss: number;
      readonly heapUsed: number;
      readonly cpuUserUs: number;
      readonly cpuSystemUs: number;
      readonly loopDelayP99Ms: number;
      readonly loopDelayMaxMs: number;
    }
  | {
      readonly type: "tool";
      readonly t: number;
      readonly id: string;
      readonly name: string;
      readonly parent?: string;
      readonly isError: boolean;
      readonly durationMs?: number;
      readonly wallMs?: number;
    }
  | {
      readonly type: "cycle";
      readonly t: number;
      readonly id: string;
      readonly rss: number;
      readonly heapUsed: number;
    }
  | { readonly type: "shutdown"; readonly t: number };

export interface AgentSamples {
  /** Pi process RSS and CPU from /proc, with the RSS of its child processes. */
  readonly pi: { t: number; rssBytes: number; cpuMs: number; childRssBytes: number }[];
  /** Cumulative CPU of the harness processes (agent runner and PTY owner), excluding Pi. */
  readonly harnessCpuMs: number[];
  readonly probe: ProbeRecord[];
}

export interface LspSample {
  readonly t: number;
  readonly languages: Record<
    string,
    { processes: number; rssBytes: number; cpuMs: number; commands: string[] }
  >;
}

interface LatencyLimit {
  readonly p95: number;
  readonly max: number;
}

export interface Thresholds {
  /** Execution time limits of top-level tool calls by tool name; `default` applies to the rest. */
  readonly toolLatencyMs: Readonly<Record<string, LatencyLimit>>;
  /** Average post-GC heap growth per cycle, from the second cycle on. */
  readonly piHeapGrowthPerCycleMb: number;
  readonly piRssPeakMb: number;
  readonly piLoopDelayMaxMs: number;
  readonly lspRssPeakMbPerLanguage: number;
  readonly minMemAvailableMb: number;
}

export interface RunData {
  readonly options: Record<string, unknown>;
  readonly servers: Record<string, string>;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly machine: readonly MachineSample[];
  readonly lsp: readonly LspSample[];
  readonly leftovers: readonly string[];
  readonly agents: readonly {
    agent: string;
    language: string;
    sizeBytes: number;
    hung: boolean;
    exitCode: number | null;
    result: AgentResult | undefined;
    samples: AgentSamples;
  }[];
  readonly thresholds: Thresholds;
}

interface Stats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

const MB = 1024 * 1024;

export function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

/** Builds the JSON and Markdown reports and evaluates the thresholds. */
export function buildReport(data: RunData): { json: unknown; markdown: string; passed: boolean } {
  const failures: string[] = [];
  /** Observations that do not fail the run. */
  const notes: string[] = [];
  const { thresholds } = data;

  const latency = new Map<
    string,
    { tool: string; language: string; nested: boolean; values: number[]; errors: number }
  >();
  for (const agent of data.agents) {
    for (const record of agent.samples.probe) {
      if (record.type !== "tool") continue;
      const nested = record.parent !== undefined;
      const tool = nested ? `codemode → ${record.name}` : record.name;
      const key = `${tool}\0${agent.language}`;
      const entry = latency.get(key) ?? {
        tool,
        language: agent.language,
        nested,
        values: [],
        errors: 0,
      };
      entry.values.push(record.durationMs ?? record.wallMs ?? 0);
      if (record.isError) entry.errors += 1;
      latency.set(key, entry);
    }
  }
  const latencyRows = [...latency.values()]
    .map((entry) => ({ ...entry, stats: stats(entry.values) }))
    .sort(
      (left, right) =>
        left.tool.localeCompare(right.tool) || left.language.localeCompare(right.language),
    );
  for (const row of latencyRows) {
    if (row.nested) continue;
    const limit = thresholds.toolLatencyMs[row.tool] ?? thresholds.toolLatencyMs.default;
    if (limit === undefined) continue;
    if (row.stats.p95 > limit.p95)
      failures.push(`${row.tool} (${row.language}) p95 ${ms(row.stats.p95)} ms > ${limit.p95} ms`);
    if (row.stats.max > limit.max)
      failures.push(`${row.tool} (${row.language}) max ${ms(row.stats.max)} ms > ${limit.max} ms`);
  }

  const agentRows = data.agents.map((agent) => {
    const result = agent.result;
    const samples = agent.samples.probe.filter((record) => record.type === "sample");
    const cycles = agent.samples.probe
      .filter((record) => record.type === "cycle")
      .map((record) => record.heapUsed / MB);
    const growth = heapGrowthPerCycle(cycles);
    const rssPeak = Math.max(0, ...agent.samples.pi.map((sample) => sample.rssBytes)) / MB;
    const loopMax = Math.max(0, ...samples.map((sample) => sample.loopDelayMaxMs));
    const loopP99 = stats(samples.map((sample) => sample.loopDelayP99Ms));
    const frames = stats(result?.frameIntervalsMs ?? []);
    const piCpuMs = agent.samples.pi.at(-1)?.cpuMs ?? 0;
    const harnessCpuMs = agent.samples.harnessCpuMs.at(-1) ?? 0;
    const failedSteps = result?.steps.filter((step) => step.problem !== undefined) ?? [];
    const label = `${agent.agent} (${agent.language})`;
    if (agent.hung) failures.push(`${label}: hung, stopped after no tool call finished in time`);
    if (result === undefined)
      failures.push(`${label}: no result (agent process exit ${agent.exitCode})`);
    else if (result.status === "crashed")
      failures.push(`${label}: session failed: ${firstLine(result.error)}`);
    for (const step of failedSteps)
      failures.push(`${label}: ${step.id} (${step.tool}): ${step.problem}`);
    for (const step of result?.steps ?? []) {
      if (step.pending !== true) continue;
      const status = /[\w-]+: pending\b[^\n]*/.exec(step.excerpt ?? "")?.[0] ?? "pending";
      notes.push(`${label}: ${step.id}: diagnostics still pending at cold start (${status})`);
    }
    for (const problem of result?.fileProblems ?? [])
      failures.push(`${label}: final file: ${problem}`);
    if (growth !== undefined && growth > thresholds.piHeapGrowthPerCycleMb) {
      failures.push(
        `${label}: heap grows ${growth.toFixed(1)} MB per cycle > ${thresholds.piHeapGrowthPerCycleMb} MB`,
      );
    }
    if (rssPeak > thresholds.piRssPeakMb)
      failures.push(
        `${label}: Pi RSS peak ${Math.round(rssPeak)} MB > ${thresholds.piRssPeakMb} MB`,
      );
    if (loopMax > thresholds.piLoopDelayMaxMs) {
      failures.push(
        `${label}: event loop blocked ${Math.round(loopMax)} ms > ${thresholds.piLoopDelayMaxMs} ms`,
      );
    }
    return {
      agent: agent.agent,
      language: agent.language,
      sizeKb: Math.round(agent.sizeBytes / 1024),
      status: agent.hung ? "hung" : (result?.status ?? "missing"),
      steps: result?.steps.length ?? 0,
      failedSteps: failedSteps.length,
      wallS: (result?.wallMs ?? 0) / 1000,
      rssPeakMb: rssPeak,
      heapAfterCycleMb: cycles,
      heapGrowthPerCycleMb: growth,
      loopDelayMaxMs: loopMax,
      loopDelayP99Ms: loopP99,
      frameIntervalsMs: frames,
      frames: frames.count,
      piCpuS: piCpuMs / 1000,
      harnessCpuS: harnessCpuMs / 1000,
      failures: failedSteps,
    };
  });

  const lspRows = [...new Set(data.lsp.flatMap((sample) => Object.keys(sample.languages)))]
    .sort()
    .map((language) => {
      const series = data.lsp
        .map((sample) => sample.languages[language])
        .filter((entry) => entry !== undefined);
      const rssPeak = Math.max(0, ...series.map((entry) => entry.rssBytes)) / MB;
      if (language !== "other" && rssPeak > thresholds.lspRssPeakMbPerLanguage) {
        failures.push(
          `${language} language servers: RSS peak ${Math.round(rssPeak)} MB > ${thresholds.lspRssPeakMbPerLanguage} MB`,
        );
      }
      return {
        language,
        processesPeak: Math.max(0, ...series.map((entry) => entry.processes)),
        rssPeakMb: rssPeak,
        cpuS: Math.max(0, ...series.map((entry) => entry.cpuMs)) / 1000,
        commands: [...new Set(series.flatMap((entry) => entry.commands))],
      };
    });

  const busy = data.machine.map((sample) => sample.cpuBusy * 100);
  const machine = {
    cpuAveragePercent: busy.reduce((sum, value) => sum + value, 0) / Math.max(1, busy.length),
    cpuPeakPercent: Math.max(0, ...busy),
    memAvailableMinMb: Math.min(...data.machine.map((sample) => sample.memAvailableBytes / MB)),
    memTotalMb: (data.machine[0]?.memTotalBytes ?? 0) / MB,
  };
  if (machine.memAvailableMinMb < thresholds.minMemAvailableMb) {
    failures.push(
      `free memory fell to ${Math.round(machine.memAvailableMinMb)} MB < ${thresholds.minMemAvailableMb} MB`,
    );
  }
  for (const leftover of data.leftovers) failures.push(`process left after the run: ${leftover}`);

  const passed = failures.length === 0;
  const json = {
    passed,
    failures,
    notes,
    options: data.options,
    servers: data.servers,
    durationS: (data.finishedAt - data.startedAt) / 1000,
    thresholds,
    toolLatencyMs: latencyRows.map(({ values: _values, ...row }) => row),
    agents: agentRows,
    languageServers: lspRows,
    machine,
    series: {
      machine: data.machine,
      languageServers: data.lsp,
      agents: Object.fromEntries(
        data.agents.map((agent) => [
          agent.agent,
          {
            pi: agent.samples.pi,
            probe: agent.samples.probe.filter(
              (record) => record.type === "sample" || record.type === "cycle",
            ),
          },
        ]),
      ),
    },
  };
  return {
    json,
    markdown: markdown(data, passed, failures, notes, latencyRows, agentRows, lspRows, machine),
    passed,
  };
}

function heapGrowthPerCycle(cycles: readonly number[]): number | undefined {
  // The first cycle warms caches and language servers; growth is measured from the second on.
  const measured = cycles.length >= 3 ? cycles.slice(1) : cycles;
  if (measured.length < 2) return undefined;
  return ((measured.at(-1) ?? 0) - (measured[0] ?? 0)) / (measured.length - 1);
}

function markdown(
  data: RunData,
  passed: boolean,
  failures: readonly string[],
  notes: readonly string[],
  latencyRows: readonly {
    tool: string;
    language: string;
    nested: boolean;
    errors: number;
    stats: Stats;
  }[],
  agentRows: readonly {
    agent: string;
    language: string;
    sizeKb: number;
    status: string;
    steps: number;
    failedSteps: number;
    wallS: number;
    rssPeakMb: number;
    heapAfterCycleMb: readonly number[];
    heapGrowthPerCycleMb: number | undefined;
    loopDelayMaxMs: number;
    frameIntervalsMs: Stats;
    piCpuS: number;
    harnessCpuS: number;
  }[],
  lspRows: readonly {
    language: string;
    processesPeak: number;
    rssPeakMb: number;
    cpuS: number;
    commands: string[];
  }[],
  machine: {
    cpuAveragePercent: number;
    cpuPeakPercent: number;
    memAvailableMinMb: number;
    memTotalMb: number;
  },
): string {
  const lines = [
    "# Tool load benchmark",
    "",
    `Result: **${passed ? "passed" : "failed"}**. ${data.agents.length} agents, ${String(data.options.cycles)} cycles, ${((data.finishedAt - data.startedAt) / 1000).toFixed(0)} s. Pi: ${String(data.options.piVersion)}.`,
    `Servers: ${Object.entries(data.servers)
      .map(([language, version]) => `${language}: ${version}`)
      .join("; ")}.`,
    "",
  ];
  if (failures.length > 0) {
    lines.push("## Failures", "", ...failures.slice(0, 60).map((failure) => `- ${failure}`));
    if (failures.length > 60) lines.push(`- … ${failures.length - 60} more in report.json`);
    lines.push("");
  }
  if (notes.length > 0) lines.push("## Notes", "", ...notes.map((note) => `- ${note}`), "");
  lines.push(
    "## Tool latency",
    "",
    "Execution time in ms. Calls nested in Codemode are listed as `codemode → tool`.",
    "",
    "| Tool | Language | Calls | Errors | p50 | p95 | Max |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...latencyRows.map(
      (row) =>
        `| ${row.tool} | ${row.language} | ${row.stats.count} | ${row.errors} | ${ms(row.stats.p50)} | ${ms(row.stats.p95)} | ${ms(row.stats.max)} |`,
    ),
    "",
    "## Pi processes",
    "",
    "Heap is measured after a full GC at the end of each cycle. Frame intervals are the gaps between synchronized TUI frames. Harness CPU is the benchmark's own terminal emulation and trace handling, outside Pi.",
    "",
    "| Agent | Language | Size KB | Status | Failed steps | Wall s | RSS peak MB | Heap per cycle MB | Growth MB/cycle | Loop delay max ms | Frames | Frame interval p95/max ms | Pi CPU s | Harness CPU s |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...agentRows.map(
      (row) =>
        `| ${row.agent} | ${row.language} | ${row.sizeKb} | ${row.status} | ${row.failedSteps}/${row.steps} | ${row.wallS.toFixed(0)} | ${Math.round(row.rssPeakMb)} | ${row.heapAfterCycleMb.map((value) => value.toFixed(0)).join(", ")} | ${row.heapGrowthPerCycleMb?.toFixed(1) ?? "–"} | ${Math.round(row.loopDelayMaxMs)} | ${row.frameIntervalsMs.count} | ${ms(row.frameIntervalsMs.p95)}/${ms(row.frameIntervalsMs.max)} | ${row.piCpuS.toFixed(1)} | ${row.harnessCpuS.toFixed(1)} |`,
    ),
    "",
    "## Language servers",
    "",
    "| Language | Processes peak | RSS peak MB | CPU s | Processes |",
    "| --- | ---: | ---: | ---: | --- |",
    ...lspRows.map(
      (row) =>
        `| ${row.language} | ${row.processesPeak} | ${Math.round(row.rssPeakMb)} | ${row.cpuS.toFixed(1)} | ${row.commands.join(", ")} |`,
    ),
    "",
    "## Machine",
    "",
    `CPU average ${machine.cpuAveragePercent.toFixed(0)}%, peak ${machine.cpuPeakPercent.toFixed(0)}%. Free memory minimum ${(machine.memAvailableMinMb / 1024).toFixed(1)} of ${(machine.memTotalMb / 1024).toFixed(1)} GiB.`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function ms(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]?.slice(0, 300) ?? "";
}
