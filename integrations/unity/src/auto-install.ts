import { inspectInstallation, installCli } from "./install.ts";
import type { SshTarget } from "./remote.ts";

export type CliReadiness = { available: boolean; detail?: string };

const failureTtlMs = 10 * 60_000;
const pending = new Map<string, Promise<CliReadiness>>();
const failures = new Map<string, { at: number; result: CliReadiness }>();

/** Forget remembered installation attempts. Used by tests. */
export function resetAutoInstall(): void {
  pending.clear();
  failures.clear();
}

export const autoInstallDisabled = () => process.env.PI_UNITY_AUTO_INSTALL === "0";

async function prepare(target: SshTarget | undefined): Promise<CliReadiness> {
  try {
    // Not tied to a caller's signal: a cancelled request must not abandon an installer half way.
    const inspection = await inspectInstallation(target);
    if (inspection.state === "found") return { available: true };
    if (inspection.state !== "missing")
      return { available: false, detail: inspection.detail || `Unity CLI is ${inspection.state}.` };
    const installed = await installCli({ confirmed: true, target });
    return installed.state === "found"
      ? { available: true }
      : {
          available: false,
          detail: installed.detail || "Unity CLI installation did not complete.",
        };
  } catch (error) {
    return {
      available: false,
      detail: `Automatic Unity CLI installation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Install the Unity CLI on the selected machine when it is missing, so the call that needed it can continue.
 * Concurrent callers share one installation; a failed attempt is remembered for a while instead of repeated.
 */
export async function ensureCli(
  target: SshTarget | undefined,
  signal?: AbortSignal,
): Promise<CliReadiness> {
  if (autoInstallDisabled())
    return {
      available: false,
      detail: "Automatic installation is disabled by PI_UNITY_AUTO_INSTALL=0.",
    };
  const key = target?.id ?? "local";
  const failed = failures.get(key);
  if (failed && Date.now() - failed.at < failureTtlMs) return failed.result;
  let attempt = pending.get(key);
  if (!attempt) {
    attempt = prepare(target)
      .then((result) => {
        if (!result.available) failures.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => pending.delete(key));
    pending.set(key, attempt);
  }
  return untilAborted(attempt, signal);
}
