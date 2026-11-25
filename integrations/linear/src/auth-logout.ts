import type { AuthRunner, AuthStatus } from "./auth-process.ts";

export type LogoutRemote =
  | "revoked"
  | "unsupported"
  | "unknown"
  | "refused"
  | "failed"
  | "not-attempted";
export interface LogoutResult {
  local: "removed" | "cancelled" | "changed" | "failed";
  remote: LogoutRemote;
  errorCode?: string;
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^LINEAR_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "LINEAR_AUTH_COMMAND_FAILED";
}

/** Remove one explicitly selected profile. Never retry a dispatched revoke. */
export async function logoutConnection(options: {
  cwd: string;
  connectionId: string;
  run: AuthRunner;
  confirm: (status: AuthStatus) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<LogoutResult> {
  const { cwd, connectionId, run, confirm, signal } = options;
  const read = (readSignal?: AbortSignal) =>
    run(cwd, ["epoch"], { connectionId, signal: readSignal });
  const original = await read(signal);
  if (original.connectionId !== connectionId) throw new Error("LINEAR_AUTH_CONTEXT_CHANGED");
  if (!(await confirm(original))) return { local: "cancelled", remote: "not-attempted" };

  let remote: LogoutRemote = "unsupported";
  let failure: string | undefined;
  let epoch = original.epoch;
  if (
    (original.state === "connected" || original.state === "expired") &&
    original.credentialType === "oauth" &&
    original.capabilities?.revoke
  ) {
    try {
      await run(cwd, ["revoke", "--forget-on-refusal"], {
        connectionId,
        expectedEpoch: epoch,
        signal,
      });
      // NamedConnections.revoke also removes the profile on success.
      return { local: "removed", remote: "revoked" };
    } catch (error) {
      failure = errorCode(error);
      remote =
        failure === "LINEAR_AUTH_REVOKE_UNKNOWN"
          ? "unknown"
          : failure === "LINEAR_AUTH_REVOKE_REFUSED"
            ? "refused"
            : failure === "LINEAR_AUTH_REVOKE_UNSUPPORTED"
              ? "unsupported"
              : "failed";
    }

    // A dispatched revoke can retire the credential before the process exits. Inspect
    // without the cancelled UI signal; the target and subsequent removal remain pinned.
    let current: AuthStatus;
    try {
      current = await read();
    } catch (error) {
      const code = errorCode(error);
      if (code === "LINEAR_AUTH_CONNECTION_REMOVED")
        return { local: "removed", remote, errorCode: failure };
      return { local: "failed", remote, errorCode: code };
    }
    if (
      current.connectionId !== connectionId ||
      (current.epoch !== epoch && current.state !== "signed-out")
    )
      return { local: "changed", remote, errorCode: failure };
    epoch = current.epoch;
  }
  try {
    await run(cwd, ["logout"], { connectionId, expectedEpoch: epoch });
    return { local: "removed", remote, ...(failure ? { errorCode: failure } : {}) };
  } catch (error) {
    const code = errorCode(error);
    return {
      local: code === "LINEAR_AUTH_CONTEXT_CHANGED" ? "changed" : "failed",
      remote,
      errorCode: code,
    };
  }
}
