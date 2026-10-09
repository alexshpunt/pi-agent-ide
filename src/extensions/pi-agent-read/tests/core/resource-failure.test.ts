import { ResourceError } from "pi-agent-resource";
import { expect, test } from "vitest";
import { failureResult } from "#src/core/tools/read/read-result.js";
import { structuredRead } from "#src/core/tools/read/structured-result.js";

test("Read keeps the safe provider source when the wrapper has no source", () => {
  const source = "fixture://owner/note%20caf%C3%A9.txt";
  const result = structuredRead(
    failureResult({
      code: "RESOLVE_FAILED",
      message: "Resolver failed",
      cause: new ResourceError("TRANSPORT_FAILED", source, "not-applied"),
    }),
  );
  expect(result.structuredContent).toMatchObject({ status: "error", errors: [{ source }] });
});
for (const declaredSafe of [false, true]) {
  test(`Read exposes provider failure codes only when declared safe (${declaredSafe})`, () => {
    const source = "fixture://owner/note%20caf%C3%A9.txt";
    const cause = declaredSafe
      ? new ResourceError("AUTH_FAILED", source, "not-applied")
      : Object.assign(new Error("Private transport diagnostic"), { code: "AUTH_FAILED", source });
    cause.message = "Private transport diagnostic";
    const result = structuredRead(
      failureResult({
        code: "RESOLVE_FAILED",
        source,
        message: declaredSafe ? "Private transport diagnostic" : "Resolver fixture failed",
        cause,
      }),
    );
    const code = declaredSafe ? "AUTH_FAILED" : "RESOLVE_FAILED";
    expect(result.structuredContent).toMatchObject({ status: "error", errors: [{ code, source }] });
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected a text failure");
    expect(block.text).toContain(code);
    expect(JSON.stringify(result)).not.toContain("Private transport diagnostic");
  });
}
