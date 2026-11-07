/** JSON-RPC MethodNotFound: the server does not implement the requested method. */
export function isMethodNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === -32_601;
}
