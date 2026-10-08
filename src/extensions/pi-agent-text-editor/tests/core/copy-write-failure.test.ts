import { ResourceError } from "pi-agent-resource";
import { expect, test } from "vitest";
import { buildFailedCopyWriteResult } from "#src/core/text-mutation.js";

for (const rollback of [undefined, { failed: [], originallyMissing: [] }]) {
  test(`Copy retains an uncertain write even when peers were rolled back (${rollback === undefined ? "no peers" : "restored peers"})`, () => {
    const source = "ssh://fixture/destination.txt";
    const result = buildFailedCopyWriteResult(
      {
        code: "WRITE_FAILED",
        source,
        message: "Write acknowledgement lost",
        cause: new ResourceError("TRANSPORT_FAILED", source, "unknown"),
        ...(rollback === undefined ? {} : { rollback }),
      },
      [],
    );
    expect(result.details.effect).toBe("unknown");
    const shown = result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(shown).toContain("effects are unknown");
    expect(shown).not.toContain("No file was changed.");
    expect(shown).not.toContain("Destination changes were rolled back.");
    expect(shown).not.toContain("Rollback failed.");
  });
}

test("Copy reports a confirmed rollback as not applied", () => {
  const result = buildFailedCopyWriteResult(
    {
      code: "WRITE_FAILED",
      source: "/destination.txt",
      message: "Write refused",
      cause: new ResourceError("CONFLICT", "/destination.txt", "not-applied"),
      rollback: { failed: [], originallyMissing: [] },
    },
    [],
  );
  expect(result.details.effect).toBe("not-applied");
});
