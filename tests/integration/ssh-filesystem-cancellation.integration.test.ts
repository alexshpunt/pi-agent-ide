import { expect, test } from "vitest";
import { probeOwnedFilesystemCancellation } from "#integration/support/ssh-filesystem-cancellation-probe.js";

for (const operation of ["write", "journal"] as const) {
  for (const mode of ["cancel", "deadline"] as const) {
    test(`filesystem ${operation} ${mode} reaps its native worker before the owned directory lock is released`, async () => {
      const proof = await probeOwnedFilesystemCancellation(mode, operation);
      expect(proof).toMatchObject({
        operation,
        mode,
        nativeGoneBeforeTeardown: true,
        siblingAliveBeforeTeardown: true,
        sourcePreserved: true,
        code: mode === "cancel" ? "CANCELLED" : "TIMEOUT",
        effect: operation === "write" ? "unknown" : "not-applied",
      });
      if (operation === "journal") expect(proof.journalGoneBeforeTeardown).toBe(true);
    }, 20000);
  }
}
