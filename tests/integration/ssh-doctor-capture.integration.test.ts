import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.js";
import * as processChannels from "#src/backend/ssh-channel.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { startSshVisionFixture } from "./support/ssh-vision-fixture.js";
import { probeOwnedDoctorCapture } from "./support/ssh-doctor-capture-probe.js";

test.each(["ready", "missing-identity", "headless", "unreachable"] as const)(
  "Doctor reports native graphics readiness for %s without claiming window authorization",
  async (mode) => {
    const result = await probeOwnedDoctorCapture(mode);
    if (mode === "ready" || mode === "missing-identity") {
      expect(result.findings[0]).toMatchObject({
        status: "pass",
        message: "Native display connection",
      });
      expect(result.findings[0]?.detail).toContain("without pixels");
      expect(result.findings[1]).toMatchObject({
        status: mode === "ready" ? "pass" : "warn",
        message: "Trusted native window identity",
      });
      if (mode === "ready")
        expect(result.findings[1]?.detail).toContain("authorization is not checked");
    } else {
      expect(result.findings).toEqual([
        {
          status: "warn",
          message: "Native capture readiness is unavailable",
          detail: `${mode === "unreachable" ? "TIMEOUT" : "DESKTOP_UNAVAILABLE"}: ${result.project}`,
        },
      ]);
    }
  },
  20_000,
);
// Guard the real native worker, not a fake capture service. Any pixel read or server grab fails.
const nonPixelGuard = `import ctypes, pathlib
_native_library = ctypes.CDLL
class NonPixelLibrary:
    def __init__(self, *args, **kwargs):
        self.library = _native_library(*args, **kwargs)
    def __getattr__(self, name):
        if name in ("XGetImage", "XGrabServer"):
            pathlib.Path(__MARKER__).write_text(name)
            raise RuntimeError("Doctor must not capture or grab the desktop")
        return getattr(self.library, name)
ctypes.CDLL = NonPixelLibrary
`;

test.each([true, false])(
  "native capture readiness checks its connection without pixels (XResource=%s)",
  async (xResource) => {
    const fixture = await startSshVisionFixture({ xResource });
    const start = processChannels.startSshProcess;
    const intercept = vi.spyOn(processChannels, "startSshProcess");
    const marker = `${fixture.target.workspace}/pixel-read`;
    try {
      const workspace = await createSshDoctorWorkspace(fixture.registry, fixture.scope);
      if (!workspace.probeCapture) throw new Error("Owner has no capture readiness probe");
      intercept.mockImplementationOnce((target, command, args, cwd, context) =>
        start(
          target,
          command,
          [
            "-c",
            nonPixelGuard.replace("__MARKER__", JSON.stringify(marker)) + args[1],
            ...args.slice(2),
          ],
          cwd,
          context,
        ),
      );
      const result = await workspace.probeCapture();
      expect(result.display.ok).toBe(true);
      expect(result.window.ok).toBe(xResource);
      if (!xResource) expect(result.window.detail).toContain("CAPABILITY_UNAVAILABLE");
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.display.detail).toContain("without pixels");
    } finally {
      intercept.mockRestore();
      await fixture.stop();
    }
  },
  20_000,
);

test("native capture readiness reports a headless project without contacting the controller desktop", async () => {
  const fixture = await startSshFixture({}, { DISPLAY: "" });
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const workspace = await createSshDoctorWorkspace(registry, project);
    if (!workspace.probeCapture) throw new Error("Owner has no capture readiness probe");
    await expect(workspace.probeCapture()).rejects.toMatchObject({
      code: "DESKTOP_UNAVAILABLE",
      source: project,
    });
  } finally {
    await fixture.stop();
  }
});
