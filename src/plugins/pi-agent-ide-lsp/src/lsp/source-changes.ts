/** Error code of a server answer that does not fit the file text it was compared with. */
export const SOURCE_CHANGED = "SOURCE_CHANGED";

/**
 * Pauses before each new attempt. Another Pi process can keep writing the file, and a server
 * index, such as clangd's for workspace symbols, catches up only after a moment.
 */
const RETRY_DELAYS_MS = [0, 100, 250, 500];

export function sourceChanged(message: string): Error {
  return Object.assign(new Error(message), { code: SOURCE_CHANGED });
}

/** Runs `action` again while it fails because the file changed under it. */
export async function retryWhileSourceChanges<T>(
  action: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      const changed = (error as { code?: unknown } | null)?.code === SOURCE_CHANGED;
      if (!changed || delay === undefined || signal?.aborted) throw error;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
