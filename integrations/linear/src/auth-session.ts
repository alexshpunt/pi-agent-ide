import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAuthCommand, isConnectionId, type AuthRunner } from "./auth-process.ts";

export interface SessionConnectionSelection {
  get(): string | undefined;
  restore(context: ExtensionContext): Promise<void>;
  select(connectionId: string | null, context: ExtensionContext): void;
}

/** Session entries contain only a profile reference. Credentials remain in the backend's private store. */
export function createSessionConnectionSelection(
  append: (type: string, data: unknown) => void,
  run: AuthRunner = runAuthCommand,
): SessionConnectionSelection {
  let current: string | undefined = "none";
  let generation = 0;
  const remember = (connectionId: string | null, context: ExtensionContext) => {
    if (connectionId !== null && !isConnectionId(connectionId))
      throw new Error("LINEAR_AUTH_INPUT_INVALID");
    current = connectionId ?? "none";
    append("linear-connection", { sessionId: context.sessionManager.getSessionId(), connectionId });
  };
  return {
    get: () => current,
    select(connectionId, context) {
      generation++;
      remember(connectionId, context);
    },
    async restore(context) {
      const restoring = ++generation;
      current = "none";
      const sessionId = context.sessionManager.getSessionId();
      const saved = context.sessionManager
        .getEntries()
        .findLast(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "linear-connection" &&
            (entry.data as { sessionId?: unknown } | undefined)?.sessionId === sessionId,
        );
      if (saved?.type === "custom") {
        const id = (saved.data as { connectionId?: unknown } | undefined)?.connectionId;
        if (id !== null && !isConnectionId(id)) throw new Error("LINEAR_AUTH_INPUT_INVALID");
        current = id ?? "none";
        return;
      }
      const status = await run(context.cwd, ["epoch"], { signal: context.signal });
      if (restoring !== generation) throw new Error("LINEAR_AUTH_CONTEXT_CHANGED");
      // Even an unconfigured chat snapshots "none" so a future shared default cannot change its principal.
      const usable =
        status.state === "connected" ||
        (status.state === "expired" && status.capabilities?.refresh);
      remember(usable ? (status.connectionId ?? null) : null, context);
    },
  };
}
