import assert from "node:assert/strict";
import { test } from "node:test";
import { validateApplication } from "./validate-js.mjs";

function evidence() {
  const observation = (properties) => ({
    properties,
    evidence: { authority: "ast-static-analysis" },
  });
  return {
    evidence_id: `ev_${"a".repeat(64)}`,
    operation: "analyze_javascript_application",
    normalized_result: {
      statistics: { parse_failures: 0, truncated_scopes: 0 },
      graph: {
        nodes: [
          {
            node_id: "channel",
            kind: "ipc-channel",
            observations: [observation({ channel: "catalog:search" })],
          },
          {
            node_id: "bridge",
            kind: "context-bridge-api",
            observations: [observation({ api_key: "catalog" })],
          },
        ],
        edges: [
          {
            source_node_id: "preload",
            target_node_id: "channel",
            relation: "invokes",
            evidence: { authority: "static-relationship-inference" },
          },
          {
            source_node_id: "handler",
            target_node_id: "channel",
            relation: "handles",
            evidence: { authority: "static-relationship-inference" },
          },
        ],
      },
    },
  };
}

test("accepts an IPC pair bound to the expected channel", () => {
  assert.equal(validateApplication(evidence()).passed, true);
});

test("rejects a handler for a different channel", () => {
  const value = evidence();
  value.normalized_result.graph.edges[1].target_node_id = "unrelated";
  assert.equal(validateApplication(value).passed, false);
});

test("does not count partial parsing or runtime authority as static success", () => {
  const partial = evidence();
  partial.normalized_result.statistics.parse_failures = 1;
  assert.equal(validateApplication(partial).passed, false);
  const runtime = evidence();
  runtime.normalized_result.graph.nodes[0].observations[0].evidence.authority =
    "passive-cdp-runtime";
  assert.equal(validateApplication(runtime).passed, false);
});

test("rejects a runtime claim on a relationship", () => {
  const value = evidence();
  value.normalized_result.graph.edges[0].evidence.authority = "passive-cdp-runtime";
  assert.equal(validateApplication(value).passed, false);
});

test("rejects a failure envelope instead of awarding an empty graph", () => {
  assert.equal(validateApplication({ error: { code: "cancelled" } }).passed, false);
});
