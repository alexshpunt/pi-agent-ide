import path from "node:path";
import { expect, test } from "vitest";
import { probeExecutable } from "./executable.js";
import { probeOwnedLocalVersion } from "./fixtures/executable-probe.js";

test.skipIf(process.platform !== "linux").each(["timeout", "cancel"] as const)(
  "a local project version probe awaits its exact owned leader after %s",
  async (mode) => {
    const result = await probeOwnedLocalVersion(mode);
    expect(result.nativeGoneBeforeCleanup).toBe(true);
    expect(result.cancellationRetained).toBe(mode === "cancel" ? true : null);
  },
  12_000,
);

test("an already cancelled version probe retains its reason without starting a command", async () => {
  const controller = new AbortController();
  const reason = new Error("Do not start a local version probe");
  controller.abort(reason);
  await expect(
    probeExecutable("owned-doctor-missing", [], process.cwd(), process.env, controller.signal),
  ).rejects.toBe(reason);
});

test("local version probes retain Unicode output, command refusal and startup errors", async () => {
  await expect(
    probeExecutable(
      process.execPath,
      ["-e", 'console.log("Owned café version"); console.log("next line")'],
      process.cwd(),
      process.env,
    ),
  ).resolves.toEqual({ ok: true, detail: "Owned café version" });
  await expect(
    probeExecutable(
      process.execPath,
      ["-e", 'console.error("Owned café refusal"); process.exitCode = 7'],
      process.cwd(),
      process.env,
    ),
  ).resolves.toEqual({ ok: false, detail: "Owned café refusal" });
  const missing = await probeExecutable(
    path.resolve(".tmp/owned-doctor-missing"),
    [],
    process.cwd(),
    process.env,
  );
  expect(missing.ok).toBe(false);
  expect(missing.detail).not.toBe("");
});
