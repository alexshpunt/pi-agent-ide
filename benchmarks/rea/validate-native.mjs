/** Check dossier identity and static call facts before using this owned fixture's pseudocode. */
export function validateNative(evidence, expectedDigest) {
  const result = evidence?.normalized_result;
  const checks = {
    evidence:
      evidence?.operation === "analyze_function" &&
      /^ev_[a-f0-9]{64}$/.test(evidence?.evidence_id ?? ""),
    artifact: evidence?.subject?.digest?.sha256 === expectedDigest,
    staticOnly: evidence?.authority === "shipped-artifact",
    provider: evidence?.provider?.id === "ghidra",
    function:
      result?.procedure?.name === "catalog_rank" &&
      result.procedure.body?.available === true &&
      result.procedure.body?.contains_entry === true,
    code:
      typeof result?.pseudocode === "string" &&
      result.pseudocode.trim().length > 0 &&
      Array.isArray(result?.assembly) &&
      result.assembly.length > 0,
    caller: result?.callers?.some((caller) => caller.name === "main") === true,
    callees: ["strlen", "tolower", "strcmp"].every(
      (name) =>
        result?.callees?.some(
          (callee) => callee.name === name || callee.name === `<EXTERNAL>::${name}`,
        ) === true,
    ),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
