import { expect, test } from "vitest";
import { probeOwnedGitCancellation } from "#integration/support/ssh-git-cancellation-probe.js";

test.each(["cancel", "deadline"] as const)(
  "guarded Git index %s awaits its native child without changing the index or a sibling",
  async (mode) => {
    const proof = await probeOwnedGitCancellation(mode);
    expect(proof.nativeGoneBeforeTeardown).toBe(true);
    expect(proof.siblingAliveBeforeTeardown).toBe(true);
    expect(proof.indexPreserved).toBe(true);
    expect(proof.sourcePreserved).toBe(true);
    expect(proof.code).toBe(mode === "cancel" ? "CANCELLED" : "TIMEOUT");
    expect(proof.effect).toBe("unknown");
  },
  20000,
);
