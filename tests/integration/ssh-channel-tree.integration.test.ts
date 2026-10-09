import { expect, test } from "vitest";
import { probeOwnedSshTree } from "./support/ssh-tree-probe.js";

for (const pty of [false, true]) {
  test.each(["cancel", "exit", "loss"] as const)(
    `owned ${pty ? "PTY" : "pipe"} %s reaps descendants that opened new sessions without touching a sibling`,
    async (mode) => {
      const proof = await probeOwnedSshTree(mode, pty);
      expect(proof).toMatchObject({
        mode,
        pty,
        nativeGoneBeforeTeardown: true,
        siblingRetained: true,
        sourcePreserved: true,
      });
      expect(new Set([proof.leader, proof.child, proof.grandchild]).size).toBe(3);
      if (mode !== "exit") {
        expect(proof.childIdentity).toMatch(/:[0-9]+$/u);
        expect(proof.grandchildIdentity).toMatch(/:[0-9]+$/u);
      }
    },
    20_000,
  );
}
