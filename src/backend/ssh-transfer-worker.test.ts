import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const worker = fileURLToPath(new URL("ssh-transfer-worker.py", import.meta.url));

// Runs the worker and sends it SIGTERM as soon as the patched call at the chosen point returns, so
// the stop lands there instead of wherever the scheduler puts it.
const stopAfter = String.raw`
import os, runpy, signal, sys, tempfile
point, worker, request = sys.argv[1:4]
fired = False
def stop():
    global fired
    if not fired:
        fired = True
        os.kill(os.getpid(), signal.SIGTERM)
if point == "cleanup":
    # Cleanup starts by ignoring further stop signals.
    real_signal = signal.signal
    def patched_signal(signum, handler):
        result = real_signal(signum, handler)
        if handler is signal.SIG_IGN:
            stop()
        return result
    signal.signal = patched_signal
else:
    real_mkstemp = tempfile.mkstemp
    def patched_mkstemp(*args, **kwargs):
        result = real_mkstemp(*args, **kwargs)
        stop()
        return result
    tempfile.mkstemp = patched_mkstemp
sys.argv = [worker, request]
try:
    runpy.run_path(worker, run_name="__main__")
finally:
    sys.stderr.write("stop sent\n" if fired else "stop not sent\n")
`;

// A stop closes the worker's input and sends SIGTERM at nearly the same time, so the signal can
// land on any line, including the start of cleanup (LPT-1435).
test.skipIf(process.platform === "win32").each([
  { moment: "as it creates its staging file", point: "staging", code: "CANCELLED" },
  { moment: "as it begins cleanup", point: "cleanup", code: "INCOMPLETE_TRANSFER" },
])("a transfer stopped $moment leaves no staging file", async ({ point, code }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-transfer-worker-"));
  try {
    const destination = path.join(directory, "target.bin");
    const size = 4096;
    const request = JSON.stringify({ destination, size, mode: 0o644, expected: null });
    // The input ends before the commit request, as it does when the sender stops.
    const result = spawnSync("python3", ["-c", stopAfter, point, worker, request], {
      input: point === "cleanup" ? Buffer.alloc(size, 65) : Buffer.alloc(0),
    });
    expect(result.stderr.toString()).toContain("stop sent");
    // The stop must not cut the worker short: it still reports why the transfer did not finish.
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, code });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
