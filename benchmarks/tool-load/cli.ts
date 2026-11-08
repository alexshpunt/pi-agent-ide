import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import type { AgentConfig, AgentResult } from "./agent.ts";
import { generateSource, languages, type LanguageId, type LanguageSpec } from "./languages.ts";
import { buildReport, type AgentSamples, type LspSample, type RunData } from "./report.ts";
import { createMachineSampler, descendants, listProcesses, type MachineSample } from "./sampler.ts";

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = findRepositoryRoot(import.meta.url);

const usage = `Usage: pnpm bench:tool-load [options]

Runs real Pi processes in TUI mode with a scripted provider (no model calls). Each agent edits its
own large generated source file through the IDE tools and checks every result.

  --agents <n>          Pi processes, spread over the languages (default 10)
  --languages <list>    cpp,typescript,python,rust (default: all four)
  --cycles <n>          Repetitions of the step sequence per agent (default 4)
  --sizes <list>        Source sizes in KB, assigned round-robin per language (default 200,500,1100)
  --shared-file <kb>    All agents of a language edit one file of this size, each in its own part,
                        like several agents working on one large source file
  --pause-ms <n>        Model think time before each scripted assistant message (default 1000; 0 = stress)
  --step-timeout <s>    An agent without a finished tool call for this long counts as hung (default 180)
  --stop-free-mb <n>    Stop every agent when free memory falls below this, before the kernel's OOM
                        killer picks unrelated processes (default 1024)
  --pi <command>        Pi executable (default: $PI_COMMAND or pi)
  --profile             Write V8 CPU profiles of every Pi process to agents/<id>/profile/
  --out <dir>           Output directory (default .tmp/tool-load/<timestamp>)
  --thresholds <file>   Threshold file (default benchmarks/tool-load/thresholds.json)
  --help                Show this help`;

const SAMPLE_INTERVAL_MS = 1000;
const IDLE_TIMEOUT_MINUTES = 0.5;

interface Options {
  readonly agents: number;
  readonly languages: readonly LanguageId[];
  readonly cycles: number;
  readonly sizesKb: readonly number[];
  /** Size of the one file all agents of a language share, or undefined for a file per agent. */
  readonly sharedFileKb: number | undefined;
  readonly pauseMs: number;
  readonly profile: boolean;
  readonly stepTimeoutMs: number;
  readonly stopFreeBytes: number;
  readonly piCommand: string;
  readonly out: string;
  readonly thresholds: string;
}

function parseOptions(): Options | undefined {
  const { values } = parseArgs({
    options: {
      agents: { type: "string", default: "10" },
      languages: { type: "string", default: "cpp,typescript,python,rust" },
      cycles: { type: "string", default: "4" },
      sizes: { type: "string", default: "200,500,1100" },
      "shared-file": { type: "string" },
      "pause-ms": { type: "string", default: "1000" },
      "step-timeout": { type: "string", default: "180" },
      "stop-free-mb": { type: "string", default: "1024" },
      pi: { type: "string", default: process.env.PI_COMMAND ?? "pi" },
      out: { type: "string" },
      thresholds: { type: "string", default: path.join(benchmarkDir, "thresholds.json") },
      profile: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return undefined;
  const selected = values.languages.split(",").map((value) => value.trim());
  for (const id of selected) {
    if (!(id in languages))
      throw new Error(`Unknown language "${id}". Use ${Object.keys(languages).join(", ")}.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    agents: positive(values.agents, "--agents"),
    languages: selected as LanguageId[],
    cycles: positive(values.cycles, "--cycles"),
    sizesKb: values.sizes.split(",").map((value) => positive(value, "--sizes")),
    sharedFileKb:
      values["shared-file"] === undefined
        ? undefined
        : positive(values["shared-file"], "--shared-file"),
    pauseMs: Number(values["pause-ms"]),
    profile: values.profile,
    stepTimeoutMs: positive(values["step-timeout"], "--step-timeout") * 1000,
    stopFreeBytes: positive(values["stop-free-mb"], "--stop-free-mb") * 1024 * 1024,
    piCommand: values.pi,
    out: path.resolve(values.out ?? path.join(repositoryRoot, ".tmp", "tool-load", stamp)),
    thresholds: path.resolve(values.thresholds),
  };
}

function positive(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${name} needs a positive number, got "${value}".`);
  return number;
}

/** Fails early when a selected language server is not runnable. */
function checkServers(selected: readonly LanguageId[]): Record<string, string> {
  const versions: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of selected) {
    const spec = languages[id];
    const [command = "", ...args] = spec.serverVersion;
    const found = tryVersion(command, args);
    if (found === undefined) missing.push(`${id}: \`${spec.serverVersion.join(" ")}\` fails`);
    else versions[id] = found;
  }
  if (missing.length > 0) {
    throw new Error(
      `Language servers unavailable:\n  ${missing.join("\n  ")}\nInstall them or pass --languages.`,
    );
  }
  return versions;
}

function tryVersion(binary: string, args: readonly string[] = ["--version"]): string | undefined {
  try {
    const output = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `${binary} ${output.trim().split("\n")[0] ?? ""}`.trim();
  } catch {
    return undefined;
  }
}

interface PlannedAgent {
  readonly config: AgentConfig;
  readonly sizeBytes: number;
}

async function prepareProjects(options: Options): Promise<PlannedAgent[]> {
  const planned: PlannedAgent[] = [];
  const byLanguage = new Map<LanguageId, string[]>();
  for (let index = 0; index < options.agents; index += 1) {
    const language = options.languages[index % options.languages.length] ?? "cpp";
    const agent = `a${String(index + 1).padStart(2, "0")}`;
    byLanguage.set(language, [...(byLanguage.get(language) ?? []), agent]);
  }
  for (const [language, agents] of byLanguage) {
    const spec = languages[language];
    const projectDir = path.join(options.out, "projects", language);
    const sharedBytes =
      options.sharedFileKb === undefined ? undefined : options.sharedFileKb * 1024;
    const shared = sharedBytes !== undefined;
    const fileStem = (agent: string) => (shared ? "agent_shared" : `agent_${agent}`);
    await writeProjectFiles(projectDir, spec, [
      ...new Set(agents.map(fileStem)),
      ...agents.map((agent) => `scratch_${agent}`),
    ]);
    // A shared file holds every agent's generated part in turn; unit lines become file lines.
    const sources = agents.map((agent, position) =>
      generateSource(
        spec,
        agent,
        sharedBytes === undefined
          ? (options.sizesKb[position % options.sizesKb.length] ?? 200) * 1024
          : sharedBytes / agents.length,
      ),
    );
    const sharedContent = sources.map((source) => source.content).join("");
    let lineOffset = 0;
    for (const [position, agent] of agents.entries()) {
      const source = sources[position];
      if (source === undefined) throw new Error(`No generated source for ${agent}`);
      const file = `src/${fileStem(agent)}.${spec.extension}`;
      const scratch = `src/scratch_${agent}.${spec.extension}`;
      const content = shared ? sharedContent : source.content;
      if (!shared || position === 0) await writeFile(path.join(projectDir, file), content);
      await writeFile(path.join(projectDir, scratch), `${spec.scratchHeader(agent, 0)}\n`);
      const unitLines = source.unitLines.map((line) => line + lineOffset);
      if (shared) lineOffset += source.content.split("\n").length - 1;
      const agentDir = path.join(options.out, "agents", agent);
      await mkdir(agentDir, { recursive: true });
      planned.push({
        sizeBytes: Buffer.byteLength(content),
        config: {
          agent,
          language,
          file,
          scratch,
          unitCount: source.unitCount,
          sizeBytes: Buffer.byteLength(content),
          unitLines,
          sharedWith: shared ? agents.length - 1 : 0,
          projectDir,
          agentDir,
          repositoryRoot,
          cycles: options.cycles,
          piCommand: options.piCommand,
          timeoutMs: options.stepTimeoutMs * 4 + options.cycles * 600_000,
          pauseMs: options.pauseMs,
          profile: options.profile,
        },
      });
    }
  }
  return planned.sort((left, right) => left.config.agent.localeCompare(right.config.agent));
}

async function writeProjectFiles(
  projectDir: string,
  spec: LanguageSpec,
  modules: readonly string[],
): Promise<void> {
  const files: Record<string, string> = {
    ...spec.projectFiles(modules),
    ".pi/settings.json": `${JSON.stringify({ codemode: { mode: "on" }, compaction: { enabled: false } }, null, 2)}\n`,
    ".pi/pi-agent-ide/extensions.json": `${JSON.stringify({ preferences: { "lsp.idle-timeout": String(IDLE_TIMEOUT_MINUTES) } }, null, 2)}\n`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(projectDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(path.join(projectDir, "src"), { recursive: true });
}

interface LiveAgent {
  readonly planned: PlannedAgent;
  readonly child: ChildProcess;
  readonly samples: AgentSamples;
  probeOffset: number;
  piPid?: number;
  lastProgressAt: number;
  finished: boolean;
  hung: boolean;
}

async function run(options: Options): Promise<number> {
  const thresholds = JSON.parse(
    await readFile(options.thresholds, "utf8"),
  ) as RunData["thresholds"];
  const servers = checkServers(options.languages);
  await mkdir(options.out, { recursive: true });
  console.log(`Output: ${options.out}`);
  const planned = await prepareProjects(options);
  const projectsRoot = path.join(options.out, "projects");
  const machine: MachineSample[] = [];
  const lsp: LspSample[] = [];
  const sampleMachine = createMachineSampler();
  await sampleMachine();

  const live: LiveAgent[] = [];
  const startedAt = Date.now();
  for (const agent of planned) {
    const configPath = path.join(agent.config.agentDir, "config.json");
    await writeFile(configPath, `${JSON.stringify(agent.config)}\n`);
    const log = createWriteStream(path.join(agent.config.agentDir, "agent.log"));
    const profileArguments = options.profile
      ? ["--cpu-prof", `--cpu-prof-dir=${path.join(agent.config.agentDir, "harness-profile")}`]
      : [];
    const child = spawn(
      process.execPath,
      [...profileArguments, path.join(benchmarkDir, "agent.ts"), configPath],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const entry: LiveAgent = {
      planned: agent,
      child,
      samples: { pi: [], harnessCpuMs: [], probe: [] },
      probeOffset: 0,
      lastProgressAt: Date.now(),
      finished: false,
      hung: false,
    };
    child.on("exit", () => {
      entry.finished = true;
    });
    live.push(entry);
  }
  console.log(
    `Started ${live.length} agents: ${options.languages.map((id) => `${id} ${planned.filter((agent) => agent.config.language === id).length}`).join(", ")}`,
  );

  let lastReport = 0;
  let stopped: string | undefined;
  while (live.some((agent) => !agent.finished)) {
    await sleep(SAMPLE_INTERVAL_MS);
    const sample = await sampleMachine();
    machine.push(sample);
    const processes = await listProcesses();
    if (stopped === undefined && sample.memAvailableBytes < options.stopFreeBytes) {
      // Out of memory, the kernel kills whatever it picks, including the user's own services.
      stopped = `free memory fell to ${Math.round(sample.memAvailableBytes / 1024 / 1024)} MB; all agents were stopped to protect the machine`;
      console.log(stopped);
      for (const agent of live)
        if (agent.child.pid !== undefined)
          for (const pid of descendants(processes, agent.child.pid)) killQuietly(pid);
    }
    const agentPids = new Set<number>();
    for (const agent of live) {
      await readProbe(agent);
      if (agent.child.pid === undefined) continue;
      const tree = descendants(processes, agent.child.pid);
      for (const pid of tree) agentPids.add(pid);
      const piTree =
        agent.piPid === undefined ? new Set<number>() : descendants(processes, agent.piPid);
      const pi = processes.find((info) => info.pid === agent.piPid);
      if (pi !== undefined) {
        agent.samples.pi.push({
          t: Date.now(),
          rssBytes: pi.rssBytes,
          cpuMs: pi.cpuMs,
          childRssBytes: processes
            .filter((info) => piTree.has(info.pid) && info.pid !== pi.pid)
            .reduce((sum, info) => sum + info.rssBytes, 0),
        });
      }
      const harnessCpu = processes
        .filter((info) => tree.has(info.pid) && !piTree.has(info.pid))
        .reduce((sum, info) => sum + info.cpuMs, 0);
      if (!agent.finished) agent.samples.harnessCpuMs.push(harnessCpu);
      if (!agent.finished && Date.now() - agent.lastProgressAt > options.stepTimeoutMs) {
        agent.hung = true;
        console.log(
          `${agent.planned.config.agent}: no finished tool call for ${options.stepTimeoutMs / 1000}s, stopping it`,
        );
        for (const pid of tree) killQuietly(pid);
      }
    }
    lsp.push(sampleLsp(processes, agentPids, projectsRoot));
    if (Date.now() - lastReport > 15_000) {
      lastReport = Date.now();
      const done = live.filter((agent) => agent.finished).length;
      const tools = live.reduce(
        (sum, agent) =>
          sum +
          agent.samples.probe.filter(
            (record) => record.type === "tool" && record.parent === undefined,
          ).length,
        0,
      );
      const last = machine.at(-1);
      console.log(
        `${Math.round((Date.now() - startedAt) / 1000)}s: ${done}/${live.length} agents done, ${tools} tool calls, CPU ${Math.round((last?.cpuBusy ?? 0) * 100)}%, free ${gib(last?.memAvailableBytes ?? 0)} GiB`,
      );
    }
  }
  const finishedAt = Date.now();

  // Language server hosts outlive their sessions by the idle timeout; anything left after that is a leak.
  const leftoverDeadline = Date.now() + IDLE_TIMEOUT_MINUTES * 60_000 + 60_000;
  let leftovers = lspProcesses(await listProcesses(), new Set(), projectsRoot);
  while (leftovers.length > 0 && Date.now() < leftoverDeadline) {
    await sleep(2000);
    leftovers = lspProcesses(await listProcesses(), new Set(), projectsRoot);
  }

  const agents: RunData["agents"][number][] = [];
  for (const agent of live) {
    await readProbe(agent);
    const resultPath = path.join(agent.planned.config.agentDir, "result.json");
    const result = await readFile(resultPath, "utf8").then(
      (content) => JSON.parse(content) as AgentResult,
      () => undefined,
    );
    agents.push({
      agent: agent.planned.config.agent,
      language: agent.planned.config.language,
      sizeBytes: agent.planned.sizeBytes,
      hung: agent.hung,
      exitCode: agent.child.exitCode,
      result,
      samples: agent.samples,
    });
  }
  const report = buildReport({
    options: {
      agents: options.agents,
      languages: options.languages,
      cycles: options.cycles,
      sizesKb: options.sizesKb,
      pauseMs: options.pauseMs,
      piCommand: options.piCommand,
      piVersion: tryVersion(options.piCommand) ?? "unknown",
    },
    servers,
    startedAt,
    finishedAt,
    machine,
    lsp,
    leftovers: leftovers.map((info) => `${info.pid} ${info.args.slice(0, 160)}`),
    ...(stopped !== undefined && { stopped }),
    agents,
    thresholds,
  });
  await writeFile(
    path.join(options.out, "report.json"),
    `${JSON.stringify(report.json, null, 2)}\n`,
  );
  await writeFile(path.join(options.out, "report.md"), report.markdown);
  console.log(`\n${report.markdown}`);
  console.log(`Report: ${path.join(options.out, "report.md")}`);
  return report.passed ? 0 : 1;
}

async function readProbe(agent: LiveAgent): Promise<void> {
  const file = path.join(agent.planned.config.agentDir, "probe.jsonl");
  const content = await readFile(file, "utf8").catch(() => "");
  if (content.length <= agent.probeOffset) return;
  const end = content.lastIndexOf("\n") + 1;
  const chunk = content.slice(agent.probeOffset, end);
  agent.probeOffset = end;
  for (const line of chunk.split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line) as AgentSamples["probe"][number];
    if (record.type === "start") agent.piPid = record.pid;
    if (record.type === "start" || record.type === "tool") agent.lastProgressAt = Date.now();
    agent.samples.probe.push(record);
  }
}

/** Language server processes and their hosts started for the benchmark projects. */
function lspProcesses(
  processes: Awaited<ReturnType<typeof listProcesses>>,
  agentPids: ReadonlySet<number>,
  projectsRoot: string,
) {
  const roots = processes.filter(
    (info) =>
      !agentPids.has(info.pid) &&
      (info.cwd.startsWith(projectsRoot) || info.args.includes(projectsRoot)),
  );
  const pids = new Set<number>();
  for (const root of roots) for (const pid of descendants(processes, root.pid)) pids.add(pid);
  return processes.filter((info) => pids.has(info.pid) && !agentPids.has(info.pid));
}

function sampleLsp(
  processes: Awaited<ReturnType<typeof listProcesses>>,
  agentPids: ReadonlySet<number>,
  projectsRoot: string,
): LspSample {
  const languagesSample: LspSample["languages"] = {};
  for (const info of lspProcesses(processes, agentPids, projectsRoot)) {
    const language =
      Object.values(languages).find(
        (spec) => spec.serverProcess.test(info.comm) || spec.serverProcess.test(info.args),
      )?.id ??
      Object.keys(languages).find(
        (id) =>
          info.cwd.startsWith(path.join(projectsRoot, id)) ||
          info.args.includes(path.join(projectsRoot, id)),
      ) ??
      "other";
    const entry = (languagesSample[language] ??= {
      processes: 0,
      rssBytes: 0,
      cpuMs: 0,
      commands: [],
    });
    entry.processes += 1;
    entry.rssBytes += info.rssBytes;
    entry.cpuMs += info.cpuMs;
    if (!entry.commands.includes(info.comm)) entry.commands.push(info.comm);
  }
  return { t: Date.now(), languages: languagesSample };
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

try {
  const options = parseOptions();
  if (options === undefined) {
    console.log(usage);
  } else {
    process.exitCode = await run(options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
