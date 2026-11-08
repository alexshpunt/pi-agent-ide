import { readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";

/** One process seen in /proc. */
export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly args: string;
  readonly cwd: string;
  readonly rssBytes: number;
  /** User plus system CPU time in milliseconds since the process started. */
  readonly cpuMs: number;
}

export interface MachineSample {
  readonly t: number;
  /** Busy share of all cores since the previous sample, 0..1. */
  readonly cpuBusy: number;
  readonly memAvailableBytes: number;
  readonly memTotalBytes: number;
}

const clockTicks = 100;
const pageSize = 4096;

/** Reads every process in /proc. Processes that exit while being read are skipped. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const entries = await readdir("/proc");
  const processes = await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => readProcess(Number(entry))),
  );
  return processes.filter((info): info is ProcessInfo => info !== undefined);
}

async function readProcess(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const [stat, cmdline, cwd] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readlink(`/proc/${pid}/cwd`).catch(() => ""),
    ]);
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const fields = stat.slice(close + 2).split(" ");
    // Fields after the command start at index 3 of proc(5): state is fields[0].
    const ppid = Number(fields[1]);
    const cpuMs = ((Number(fields[11]) + Number(fields[12])) * 1000) / clockTicks;
    const rssBytes = Number(fields[21]) * pageSize;
    return { pid, ppid, comm, args: cmdline.split("\0").join(" ").trim(), cwd, rssBytes, cpuMs };
  } catch {
    return undefined;
  }
}

/** Returns every descendant pid of `root`, including `root`. */
export function descendants(processes: readonly ProcessInfo[], root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const info of processes) {
    const list = children.get(info.ppid) ?? [];
    list.push(info.pid);
    children.set(info.ppid, list);
  }
  const result = new Set<number>();
  const queue = [root];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    if (result.has(pid)) continue;
    result.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

/** Samples machine CPU and memory; the first call only primes the CPU counters. */
export function createMachineSampler(): () => Promise<MachineSample> {
  let previous: { busy: number; total: number } | undefined;
  return async () => {
    const [stat, meminfo] = await Promise.all([
      readFile("/proc/stat", "utf8"),
      readFile("/proc/meminfo", "utf8"),
    ]);
    const cpu = (stat.split("\n")[0] ?? "").trim().split(/\s+/).slice(1).map(Number);
    const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
    const total = cpu.reduce((sum, value) => sum + value, 0);
    const current = { busy: total - idle, total };
    const cpuBusy =
      previous === undefined || current.total === previous.total
        ? 0
        : (current.busy - previous.busy) / (current.total - previous.total);
    previous = current;
    const field = (name: string): number =>
      Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? 0) * 1024;
    return {
      t: Date.now(),
      cpuBusy,
      memAvailableBytes: field("MemAvailable"),
      memTotalBytes: field("MemTotal") || os.totalmem(),
    };
  };
}
