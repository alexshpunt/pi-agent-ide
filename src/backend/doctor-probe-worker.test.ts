import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const worker = fileURLToPath(new URL("doctor-probe-worker.py", import.meta.url));

// Runs the worker and sends it SIGTERM just before its rollback starts ignoring further TERM
// requests, so the stop lands as the rollback begins.
const stopAsRollbackBegins = String.raw`
import os, runpy, signal, sys
worker, request = sys.argv[1:3]
fired = False
real_signal = signal.signal
def patched_signal(signum, handler):
    global fired
    if not fired and signum == signal.SIGTERM and handler is signal.SIG_IGN:
        fired = True
        os.kill(os.getpid(), signal.SIGTERM)
    return real_signal(signum, handler)
signal.signal = patched_signal
sys.argv = [worker, request]
try:
    runpy.run_path(worker, run_name="__main__")
finally:
    sys.stderr.write("stop sent\n" if fired else "stop not sent\n")
`;

// A stop closes the worker's input and sends TERM almost together. The closed input starts the
// rollback, and TERM can land as it begins (LPT-1435).
test.skipIf(process.platform === "win32")(
  "a probe stopped as its rollback begins leaves no probe directory",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-doctor-probe-"));
    try {
      const request = JSON.stringify({
        operation: "create",
        source: path.join(directory, "probe.txt"),
      });
      const result = spawnSync("python3", ["-c", stopAsRollbackBegins, worker, request], {
        input: Buffer.alloc(0),
      });
      expect(result.stderr.toString()).toContain("stop sent");
      // The receipt shows the probe directory existed before the stop.
      expect(result.stdout.toString()).toContain(".pi-agent-ide-doctor-");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
