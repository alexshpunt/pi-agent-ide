import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeExecutable } from "../executable.js";
import { probeProjectExecutable } from "../project-probes.js";

async function ownedPid(marker: string): Promise<number> {
  const pid = Number(await readFile(marker, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned version probe PID");
  return pid;
}
async function gone(pid: number): Promise<boolean> {
  try {
    await stat(`/proc/${pid}`);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return true;
    throw error;
  }
}

/** Check a real local probe leader before removing its owned fixture; no descendant-tree claim. */
export async function probeOwnedLocalVersion(mode: "timeout" | "cancel") {
  if (process.platform !== "linux") throw new Error("Native PID inspection needs Linux");
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/doctor-version-"));
  const marker = path.join(root, "leader.pid");
  const release = path.join(root, "release");
  const controller = new AbortController();
  const reason = new Error("Cancel local owned version probe");
  const args = [path.resolve("packages/pi-agent-doctor/src/fixtures/probe-executable-wait.mjs"), marker, release];
  const pending = (mode === "timeout"
    ? probeExecutable(process.execPath, args, root, process.env)
    : probeProjectExecutable({
        cwd: root, files: [], detectedLanguageIds: new Set(),
        detectedLanguages: new Map(), env: process.env, signal: controller.signal,
      }, process.execPath, args)
  ).catch((error: unknown) => error);
  try {
    const readyDeadline = Date.now() + 2000;
    let pid: number;
    for (;;) {
      try { pid = await ownedPid(marker); break; }
      catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        if (Date.now() >= readyDeadline) throw new Error("Owned probe did not start", { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (mode === "cancel") controller.abort(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Local probe did not finish within its cleanup bound")), mode === "cancel" ? 3000 : 8000);
    });
    let result: unknown;
    try { result = await Promise.race([pending, deadline]); }
    finally { clearTimeout(timer); }
    if (mode === "cancel" ? result !== reason : !(typeof result === "object" && result !== null && "ok" in result && result.ok === false))
      throw new Error("Unexpected owned version probe outcome", { cause: result });
    if (!(await gone(pid))) throw new Error("Version probe returned while its exact owned leader was alive");
    return { root, mode, pid, nativeGoneBeforeCleanup: true, cancellationRetained: mode === "cancel" ? result === reason : null };
  } finally {
    controller.abort(reason);
    // Release the exact fixture even during RED, without numeric PID control.
    await writeFile(release, "release");
    let pid: number | undefined;
    try { pid = await ownedPid(marker); }
    catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    const deadline = Date.now() + 2000;
    while (pid !== undefined && !(await gone(pid)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (pid !== undefined && !(await gone(pid))) throw new Error("Owned version probe remained after release");
    await pending;
    await rm(root, { recursive: true, force: true });
  }
}
