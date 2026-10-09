import { expect, test } from "vitest";
import { probeSshLspCarrierLoss } from "#integration/support/lsp-carrier-loss-probe.js";

test("actual SSH carrier loss rejects a pending language-server request and restarts without stale diagnostics", async () => {
  const proof = await probeSshLspCarrierLoss();
  expect(proof.restartedPid).not.toBe(proof.pid);
  expect(proof).toMatchObject({
    requestRejected: true,
    oldGoneBeforeTeardown: true,
    newGoneBeforeTeardown: true,
    diagnosticsCleared: true,
    canonicalSymbol: true,
  });
}, 60000);
