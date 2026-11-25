/** Closed credential/selection refusals that may cross native transport boundaries without private text. */
export const CONNECTION_FAILURES = [
  "LINEAR_AUTH_NATIVE_UNAVAILABLE",
  "LINEAR_AUTH_STORAGE_UNAVAILABLE",
  "LINEAR_AUTH_CONNECTION_REMOVED",
  "LINEAR_AUTH_CONTEXT_CHANGED",
] as const;
type ConnectionFailure = Error & { readonly message: (typeof CONNECTION_FAILURES)[number] };

export function isConnectionFailure(error: unknown): error is ConnectionFailure {
  return (
    error instanceof Error && (CONNECTION_FAILURES as readonly string[]).includes(error.message)
  );
}
