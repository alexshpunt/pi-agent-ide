import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { startSshProcess } from "#src/backend/ssh-channel.js";
import { startSshFixture } from "./support/ssh-fixture.js";

// These private shims exercise the real native worker's refusal boundary, not OS policy.
test.each(["missing", "denied"] as const)(
  "a %s subreaper facility refuses the command before starting user code",
  async (mode) => {
    const fixture = await startSshFixture(
      { python3: path.resolve("tests/integration/fixtures/ssh-subreaper-refusal.py") },
      { PI_IDE_SUBREAPER_REFUSAL: mode },
    );
    const marker = `${fixture.workspace}/user-command-started`;
    try {
      await expect(
        startSshProcess(
          {
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          },
          "/usr/bin/python3",
          ["-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('started')", marker],
          fixture.workspace,
        ),
      ).rejects.toMatchObject({
        code: mode === "missing" ? "CAPABILITY_UNAVAILABLE" : "EPERM",
        source: `ssh://fixture${fixture.workspace}`,
        effect: "not-applied",
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.stop();
    }
  },
  15_000,
);
