import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Environment variable naming the JSONL file that receives this Pi process's measurements. */
export const PROBE_FILE_ENVIRONMENT = "PI_TOOL_LOAD_PROBE_FILE";
/** Tool call IDs ending with this suffix mark the end of a cycle; the probe measures heap after GC there. */
export const CYCLE_END_SUFFIX = "-cycle-end";

const SAMPLE_INTERVAL_MS = 250;

/**
 * Loaded into each benchmarked Pi process. Records memory, CPU and event loop delay over time,
 * every tool execution (including calls nested in Codemode), and the heap after a full GC at
 * each cycle boundary.
 */
export default function toolLoadProbe(pi: ExtensionAPI): void {
  const file = process.env[PROBE_FILE_ENVIRONMENT];
  if (file === undefined || file.length === 0) return;

  const pending: string[] = [];
  const record = (value: Record<string, unknown>): void => {
    pending.push(JSON.stringify({ t: Date.now(), ...value }));
  };
  const flush = (): void => {
    if (pending.length === 0) return;
    appendFileSync(file, `${pending.join("\n")}\n`, "utf8");
    pending.length = 0;
  };

  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();

  record({ type: "start", pid: process.pid, node: process.version });
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    record({
      type: "sample",
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      loopDelayP50Ms: delay.percentile(50) / 1e6,
      loopDelayP99Ms: delay.percentile(99) / 1e6,
      loopDelayMaxMs: delay.max / 1e6,
    });
    delay.reset();
    flush();
  }, SAMPLE_INTERVAL_MS);
  timer.unref();

  const started = new Map<string, number>();
  pi.on("tool_execution_start", (event) => {
    started.set(event.toolCallId, performance.now());
  });
  pi.on("tool_execution_end", (event) => {
    const start = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    record({
      type: "tool",
      id: event.toolCallId,
      name: event.toolName,
      parent: event.parentToolCallId,
      isError: event.isError,
      durationMs: event.durationMs,
      wallMs: start === undefined ? undefined : performance.now() - start,
    });
    if (event.toolCallId.endsWith(CYCLE_END_SUFFIX)) {
      gc();
      const memory = process.memoryUsage();
      record({ type: "cycle", id: event.toolCallId, rss: memory.rss, heapUsed: memory.heapUsed });
    }
    flush();
  });
  pi.on("session_shutdown", () => {
    clearInterval(timer);
    record({ type: "shutdown" });
    flush();
  });
}
