import assert from "node:assert/strict";
import { test } from "vitest";
import { parseToolCapture, renderToolCapture } from "./render-tool-schemas.js";

test("retains nested contracts and every changed request", () => {
  const tool = {
    name: "example",
    description: "",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
  };
  const changed = { ...tool, parameters: { ...tool.parameters, required: ["value"] } };
  const records = [
    { tools: [tool] },
    { tools: [tool] },
    { tools: [{ type: "function", function: changed }] },
  ];
  const requests = parseToolCapture(records.map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(
    requests.map((request) => request.tools[0]?.parameters),
    [tool.parameters, tool.parameters, changed.parameters],
  );
  const markdown = renderToolCapture(requests);
  const definitions = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(
    (match) => JSON.parse(match[1] ?? "") as unknown,
  );
  assert.deepEqual(definitions, [tool, records[2]?.tools[0]]);
  assert.deepEqual(parseToolCapture(JSON.stringify([tool]))[0]?.tools[0]?.raw, tool);
  assert.throws(() => parseToolCapture('{"tools":null}'));
});
