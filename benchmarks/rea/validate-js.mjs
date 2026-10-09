/** Check static Electron facts against this fixture's source-owned ground truth. */
export function validateApplication(evidence) {
  const result = evidence?.normalized_result;
  const nodes = result?.graph?.nodes ?? [];
  const edges = result?.graph?.edges ?? [];
  const channels = nodes.filter(
    (node) =>
      node.kind === "ipc-channel" &&
      node.observations.some((observation) => observation.properties?.channel === "catalog:search"),
  );
  const checks = {
    evidence:
      evidence?.operation === "analyze_javascript_application" &&
      /^ev_[a-f0-9]{64}$/.test(evidence?.evidence_id ?? ""),
    parsing: result?.statistics?.parse_failures === 0 && result?.statistics?.truncated_scopes === 0,
    bridge: nodes.some(
      (node) =>
        node.kind === "context-bridge-api" &&
        node.observations.some((observation) => observation.properties?.api_key === "catalog"),
    ),
    ipcPair: channels.some(
      (channel) =>
        edges.some(
          (edge) => edge.target_node_id === channel.node_id && edge.relation === "invokes",
        ) &&
        edges.some(
          (edge) => edge.target_node_id === channel.node_id && edge.relation === "handles",
        ),
    ),
    staticOnly:
      nodes.length > 0 &&
      [...nodes.flatMap((node) => node.observations), ...edges].every((fact) =>
        [
          "artifact-bytes",
          "ast-static-analysis",
          "static-relationship-inference",
          "unknown",
        ].includes(fact.evidence?.authority),
      ),
  };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}
