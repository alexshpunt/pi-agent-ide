import assert from "node:assert/strict";

/** Read REA's structured success or single JSON error block without treating an error as Evidence. */
export function mcpData(response) {
  if (response.isError === true) {
    assert.equal(response.content?.length, 1, "Expected one REA error block");
    const block = response.content[0];
    assert.equal(block.type, "text");
    const data = JSON.parse(block.text);
    assert.equal(typeof data.error?.code, "string", "Missing REA error code");
    return data.error;
  }
  assert.ok(
    response.structuredContent && typeof response.structuredContent === "object",
    "Missing structured REA result",
  );
  return response.structuredContent;
}
