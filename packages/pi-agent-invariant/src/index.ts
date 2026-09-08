/** Return a value that must exist or throw when an internal invariant is broken. */
export function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be defined");
  }

  return value;
}
