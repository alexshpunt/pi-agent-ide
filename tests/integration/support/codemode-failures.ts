/**
 * The block that ends a Codemode result when IDE calls failed, from its count line such as
 * "2 of 3 IDE calls failed:" to the end of the result, or "" when no IDE call failed.
 * A failed IDE call resolves to null in the script; its reason is only in this block.
 */
export function codemodeFailures(output: string): string {
  const start = output.search(/^\d+ of \d+ IDE calls? failed:$/mu);
  return start < 0 ? "" : output.slice(start);
}
