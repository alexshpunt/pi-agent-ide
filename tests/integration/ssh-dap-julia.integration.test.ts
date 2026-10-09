import { expect, test } from "vitest";
import { probeOwnedSshJulia } from "#integration/support/ssh-julia-probe.js";

const runtime = process.env.PI_IDE_JULIA_PATH;
const project = process.env.PI_IDE_JULIA_DEBUG_PROJECT;
const depot = process.env.PI_IDE_JULIA_DEPOT;

test.skipIf(!runtime || !project || !depot)(
  "real private Julia stops at canonical source, steps 42 to 43 and reaps its native adapter",
  async () => {
    if (!runtime || !project || !depot)
      throw new Error("Select the private Julia installation explicitly");
    const proof = await probeOwnedSshJulia({ runtime, project, depot });
    expect(proof).toMatchObject({
      before: "42",
      after: "43",
      nativeGoneBeforeTeardown: true,
      sourcePreserved: true,
    });
    expect(proof.pid).not.toBe(proof.relayPid);
    expect(proof.identity).toMatch(/^[a-f0-9-]+:\d+$/u);
    expect(proof.relayIdentity).toMatch(/^[a-f0-9-]+:\d+$/u);
    expect(proof.source).toContain("note-caf%C3%A9.jl");
  },
  60_000,
);
