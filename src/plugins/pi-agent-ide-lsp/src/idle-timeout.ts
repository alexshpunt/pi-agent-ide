/** IDE setting with the minutes a language server may stay idle before it stops. */
export const LSP_IDLE_TIMEOUT_SETTING = "lsp.idle-timeout";

const DEFAULT_IDLE_MINUTES = 10;

/** Convert the saved minutes to milliseconds; an empty value means the default. */
export function lspIdleTimeoutMs(value: string): number {
  const text = value.trim();
  const minutes = text === "" ? DEFAULT_IDLE_MINUTES : Number(text);
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error(
      `Invalid ${LSP_IDLE_TIMEOUT_SETTING} setting "${value}": use a positive number of minutes.`,
    );
  return Math.round(minutes * 60_000);
}
