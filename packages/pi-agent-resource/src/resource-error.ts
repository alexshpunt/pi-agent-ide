import { resourceErrorMetadataOf, type ResourceErrorMetadata } from "./resource-error-metadata.js";

const resourceErrorBrand = Symbol.for("pi-agent-resource.ResourceError");
/**
 * A provider failure whose code and source are safe to show to the agent and user.
 * Providers must remove credentials and private transport diagnostics before creating it.
 * Consumers use these fields, not arbitrary exception messages or matching object shapes.
 */
export class ResourceError extends Error {
  readonly [resourceErrorBrand] = true;
  readonly metadata?: ResourceErrorMetadata;

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
    options?: { readonly cause?: ResourceError; readonly metadata?: ResourceErrorMetadata },
  ) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(code)) throw new TypeError("Invalid resource failure code");
    super(`${code}: ${source}`, options);
    this.name = "ResourceError";
    const metadata = resourceErrorMetadataOf(options);
    if (metadata) this.metadata = metadata;
  }
}
