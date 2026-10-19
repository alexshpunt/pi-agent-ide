const resourceErrorBrand = Symbol.for("pi-agent-resource.ResourceError");
/**
 * A provider failure whose code and source are safe to show to the agent and user.
 * Providers must remove credentials and private transport diagnostics before creating it.
 * Consumers use these fields, not arbitrary exception messages or matching object shapes.
 */
export class ResourceError extends Error {
  readonly [resourceErrorBrand] = true;

  /** Recognize failures from separately loaded extension SDKs without trusting error-shaped objects. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[resourceErrorBrand] === true
    );
  }
  constructor(
    readonly code: string,
    readonly source: string,
    readonly effect: "not-applied" | "applied" | "unknown",
    options?: { readonly cause: ResourceError },
  ) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(code)) throw new TypeError("Invalid resource failure code");
    super(`${code}: ${source}`, options);
    this.name = "ResourceError";
  }
}
