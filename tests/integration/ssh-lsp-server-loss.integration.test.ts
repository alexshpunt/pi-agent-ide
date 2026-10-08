import { expect, test } from "vitest";
import { probeSshLspServerLoss } from "#integration/support/lsp-server-loss-probe.js";

test("an actual owned server exit rejects its request and restarts without stale process state", async () => {
  const proof = await probeSshLspServerLoss();
  expect(proof.pid).toBeGreaterThan(0);
  expect(proof.restartedPid).not.toBe(proof.pid);
  expect(proof).toMatchObject({
    exitCode: 7,
    rejectedRequest: true,
    oldGoneBeforeTeardown: true,
    newGoneBeforeTeardown: true,
    canonicalSymbol: true,
  });
}, 30000);
