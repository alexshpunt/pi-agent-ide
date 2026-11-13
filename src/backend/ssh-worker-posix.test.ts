import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const backend = fileURLToPath(new URL(".", import.meta.url));

// Runs one request through the POSIX worker and sends it SIGTERM right after it closes the
// write handle of a file whose name ends with the given suffix. The operations below close that
// handle first thing in a finally block, so the stop lands as cleanup begins.
const stopAfterClose = String.raw`
import fcntl, os, signal, sys
backend, suffix = sys.argv[1:3]
# Importing from the source tree must not leave a __pycache__ directory in it.
sys.dont_write_bytecode = True
sys.path.insert(0, backend)
import ssh_worker_common, ssh_worker_posix
fired = False
real_close = os.close
def patched_close(fd):
    global fired
    try:
        target = os.readlink("/proc/self/fd/" + str(fd))
        writing = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_WRONLY
    except OSError:
        target, writing = "", False
    real_close(fd)
    if not fired and writing and target.endswith(suffix):
        fired = True
        os.kill(os.getpid(), signal.SIGTERM)
os.close = patched_close
try:
    ssh_worker_common.run(ssh_worker_posix)
finally:
    sys.stderr.write("stop sent\n" if fired else "stop not sent\n")
`;

interface WorkerRequest {
  readonly operation: string;
  readonly path: string;
  readonly [field: string]: unknown;
}

function stopDuringCleanup(suffix: string, request: WorkerRequest) {
  const result = spawnSync("python3", ["-c", stopAfterClose, backend, suffix], {
    input: JSON.stringify(request),
  });
  expect(result.stderr.toString()).toContain("stop sent");
  return JSON.parse(result.stdout.toString()) as { ok: boolean; code?: string };
}

// A stop can land on any line, including the start of a finally block that removes a temporary
// file (LPT-1435). The worker removes what that block could not before it replies.
test.skipIf(process.platform === "win32")(
  "a write stopped as its cleanup begins leaves no staging file",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-ssh-worker-"));
    try {
      const target = path.join(directory, "target.txt");
      await writeFile(target, "before");
      // A stale expected version fails the write after its staging file exists.
      const reply = stopDuringCleanup("target.txt", {
        operation: "write",
        path: target,
        bytes: Buffer.from("after").toString("base64"),
        expected: "stale",
      });
      expect(reply).toMatchObject({ ok: false, code: "CANCELLED" });
      expect(await readdir(directory)).toEqual(["target.txt"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a Git index update stopped as its cleanup begins leaves no index lock",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-ssh-worker-"));
    try {
      expect(spawnSync("git", ["init", "-q", directory]).status).toBe(0);
      // A stale HEAD fails the update while it holds Git's index lock.
      const reply = stopDuringCleanup("index.lock", {
        operation: "gitIndex",
        path: directory,
        repositoryPath: "file.txt",
        mode: "100644",
        expectedHead: "stale",
      });
      expect(reply).toMatchObject({ ok: false, code: "CANCELLED" });
      expect(await readdir(path.join(directory, ".git"))).not.toContain("index.lock");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
