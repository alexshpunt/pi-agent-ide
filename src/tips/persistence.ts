import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import path from "node:path";

const STATE_VERSION = 1;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
let writeQueue = Promise.resolve();

interface TipState {
  readonly version: 1;
  readonly projects: Record<string, readonly string[]>;
}

/** Returns the global, configurable startup-tip state path. */
export function resolveTipStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
  return path.join(root, "pi-agent-ide", "tips.json");
}

/**
Stores shown tips globally while treating malformed or unwritable state as empty.
*/
export class TipStateStore {
  public constructor(private readonly statePath = resolveTipStatePath()) {}

  /** Returns IDs already shown for one project. */
  public async shownFor(project: string): Promise<ReadonlySet<string>> {
    const state = await readState(this.statePath);
    return new Set(state.projects[project] ?? []);
  }

  /** Claims a provider-scoped tip if it has not been shown for one project. */
  public async claimIfUnseen(
    project: string,
    tipIdentity: string,
    legacyTipId?: string,
  ): Promise<boolean> {
    const claim = writeQueue.then(async () => {
      try {
        return await withStateLock(this.statePath, async () => {
          const state = await readState(this.statePath);
          const existing = new Set(state.projects[project] ?? []);
          if (
            existing.has(tipIdentity) ||
            (legacyTipId !== undefined && existing.has(legacyTipId))
          ) {
            return false;
          }

          existing.add(tipIdentity);
          const next: TipState = {
            version: STATE_VERSION,
            projects: { ...state.projects, [project]: [...existing] },
          };
          await writeState(this.statePath, next);
          return true;
        });
      } catch {
        // State is an optimization. Permit rendering when the claim cannot be persisted.
        return true;
      }
    });
    writeQueue = claim.then(
      () => undefined,
      () => undefined,
    );
    return claim;
  }

  /** Atomically records IDs shown for one project; persistence failures are ignored. */
  public async markShown(project: string, tipIds: readonly string[]): Promise<void> {
    if (tipIds.length === 0) {
      return;
    }

    const update = writeQueue.then(async () => {
      await withStateLock(this.statePath, async () => {
        const state = await readState(this.statePath);
        const existing = new Set(state.projects[project] ?? []);
        for (const tipId of tipIds) {
          existing.add(tipId);
        }

        const next: TipState = {
          version: STATE_VERSION,
          projects: { ...state.projects, [project]: [...existing] },
        };
        await writeState(this.statePath, next);
      });
    });
    writeQueue = update.catch(() => {});
    await writeQueue;
  }

  /** Removes a failed claim without blocking startup when persistence is unavailable. */
  public async unmarkShown(project: string, tipIdentity: string): Promise<void> {
    const update = writeQueue.then(async () => {
      try {
        await withStateLock(this.statePath, async () => {
          const state = await readState(this.statePath);
          const existing = new Set(state.projects[project] ?? []);
          if (!existing.delete(tipIdentity)) {
            return;
          }

          const next: TipState = {
            version: STATE_VERSION,
            projects: { ...state.projects, [project]: [...existing] },
          };
          await writeState(this.statePath, next);
        });
      } catch {
        // State is an optimization. Never block startup on a failed cleanup.
      }
    });
    writeQueue = update.catch(() => {});
    await writeQueue;
  }
}

/** Normalizes a project path for use as a state key. */
export function normalizeProjectPath(project: string): string {
  return path.resolve(project);
}

async function readState(statePath: string): Promise<TipState> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isState(value)) {
      return emptyState();
    }
    return value;
  } catch {
    return emptyState();
  }
}

async function withStateLock<T>(statePath: string, update: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(statePath), { recursive: true });
  const startedAt = Date.now();

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      try {
        const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAge > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between mkdir and stat; retry immediately.
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for startup-tip state lock: ${lockPath}`, {
          cause: error,
        });
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await update();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

async function writeState(statePath: string, state: TipState): Promise<void> {
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, statePath);
    } finally {
      // A failed rename can leave a temporary file, but cleanup is best effort.
      await rm(temporaryPath, { force: true });
    }
  } catch {
    // State is an optimization. Never block startup on a read-only home directory.
  }
}

function emptyState(): TipState {
  return { version: STATE_VERSION, projects: {} };
}

function isState(value: unknown): value is TipState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    record.version !== STATE_VERSION ||
    typeof record.projects !== "object" ||
    record.projects === null
  ) {
    return false;
  }

  return Object.values(record.projects).every(
    (tips) => Array.isArray(tips) && tips.every((tip) => typeof tip === "string"),
  );
}
