import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostProbe, installCli } from "#unity/install.ts";
import { cli } from "#unity/backend.ts";

// Downloads and runs Unity's real installer. Set UNITY_TEST_REAL_INSTALL=1 to run it.
void test(
  "official POSIX installer produces a usable CLI in an isolated home",
  { skip: !process.env.UNITY_TEST_REAL_INSTALL },
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "unity-real-install-"));
    const old = { ...process.env };
    const probe = { ...hostProbe };
    try {
      // Isolated from a Windows host: when run in WSL, take the Linux path.
      if (hostProbe.platform() === "linux") hostProbe.osrelease = async () => "linux";
      process.env.HOME = home;
      process.env.PATH = "/usr/bin:/bin";
      delete process.env.PI_UNITY_CLI;
      delete process.env.PI_UNITY_INSTALLER_BASE;
      const installed = await installCli({ confirmed: true });
      assert.equal(installed.state, "found");
      assert.equal(installed.executable, path.join(home, ".local/share/pi-agent-unity/bin/unity"));
      await assert.rejects(cli(["status"]), (error: Error) => {
        const errors = JSON.parse(error.message) as { code: string }[];
        return errors[0].code === "STATUS_NO_INSTANCES";
      });
    } finally {
      Object.assign(hostProbe, probe);
      process.env = old;
      await rm(home, { recursive: true, force: true });
    }
  },
);
